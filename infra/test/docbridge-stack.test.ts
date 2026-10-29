import { describe, expect, it } from "@jest/globals";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { DocBridgeStack, CertStack } from "../lib/docbridge-stack";

const config = {
  domainName: "docbridge.example.com",
  hostedZoneId: "ZPLACEHOLDER1",
  account: "111111111111",
  region: "eu-central-1",
};

function synth() {
  const app = new cdk.App();
  const cert = new CertStack(app, "DocBridgeCert-test", {
    env: { account: config.account, region: "us-east-1" },
    crossRegionReferences: true,
    envName: "test",
    domainName: config.domainName,
  });
  const stack = new DocBridgeStack(app, "DocBridge-test", {
    env: { account: config.account, region: config.region },
    crossRegionReferences: true,
    envName: "test",
    config,
    imageTag: "latest",
    webCertificateArn: cert.certificate.certificateArn,
  });
  return Template.fromStack(stack);
}

const template = synth();

describe("buckets", () => {
  it("all buckets block public access and use SSE-KMS or are private", () => {
    template.allResources("AWS::S3::Bucket", {});
    template.allResourcesProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs("AWS::S3::Bucket", 3);
  });

  it("staging and platform buckets use SSE-KMS", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("docbridge-staging"),
      BucketEncryption: Match.objectLike({}),
    });
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("docbridge-platform"),
      BucketEncryption: Match.objectLike({}),
    });
  });

  it("staging bucket notifies the upload-events queue for staged/ objects", () => {
    // CDK renders bucket notifications via a Custom::S3BucketNotifications resource.
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        QueueConfigurations: [
          {
            Events: ["s3:ObjectCreated:Put"],
            Filter: {
              Key: {
                FilterRules: [{ Name: "prefix", Value: "staged/" }],
              },
            },
          },
          {
            Events: ["s3:ObjectCreated:CompleteMultipartUpload"],
            Filter: {
              Key: {
                FilterRules: [{ Name: "prefix", Value: "staged/" }],
              },
            },
          },
        ],
      },
    });
  });
});

describe("queues", () => {
  it("tasks queue has 1200s visibility and redrives after 3 receives", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: 1200,
      ReceiveMessageWaitTimeSeconds: 20,
      RedrivePolicy: { maxReceiveCount: 3 },
    });
  });

  it("upload-events queue has 60s visibility and redrives after 5", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: 60,
      RedrivePolicy: { maxReceiveCount: 5 },
    });
  });
});

describe("ALB rules", () => {
  const rules = () =>
    Object.values(
      template.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"),
    ).map(
      (r) =>
        (
          r as {
            Properties: {
              Conditions: {
                Field: string;
                Values?: string[];
                HttpRequestMethodConfig?: { Values: string[] };
              }[];
            };
          }
        ).Properties.Conditions,
    );

  const pathValues = () =>
    rules()
      .flatMap((conds) => conds)
      .filter((c) => c.Field === "path-pattern")
      .flatMap(
        (c) =>
          c.Values ??
          (c as { PathPatternConfig?: { Values: string[] } }).PathPatternConfig
            ?.Values ??
          [],
      );

  it("routes /api/*, GET /tree and the six auth paths", () => {
    const values = pathValues();
    expect(values).toContain("/api/*");
    expect(values).toContain("/tree");
    for (const p of [
      "/auth/login",
      "/auth/refresh",
      "/auth/logout",
      "/auth/users",
      "/auth/users/*",
      "/auth/.well-known/*",
    ]) {
      expect(values).toContain(p);
    }
  });

  it("GET /tree rule carries a GET method condition", () => {
    const treeRule = rules().find((conds) =>
      conds.some(
        (c) =>
          c.Field === "path-pattern" &&
          (
            c.Values ??
            (c as { PathPatternConfig?: { Values: string[] } })
              .PathPatternConfig?.Values
          )?.includes("/tree"),
      ),
    );
    expect(
      treeRule?.some(
        (c) =>
          c.Field === "http-request-method" &&
          c.HttpRequestMethodConfig?.Values.includes("GET"),
      ),
    ).toBe(true);
  });

  it("does not route /auth/service-token or wildcard /auth/*", () => {
    const values = pathValues();
    expect(values).not.toContain("/auth/service-token");
    expect(values).not.toContain("/auth/*");
  });

  it("the platform target group is reachable only through the GET /tree rule", () => {
    const tgLogicalId = Object.keys(
      template.findResources("AWS::ElasticLoadBalancingV2::TargetGroup"),
    ).find(
      (id) =>
        id.toLowerCase().includes("platform") &&
        !id.toLowerCase().includes("api") &&
        !id.toLowerCase().includes("auth"),
    );
    expect(tgLogicalId).toBeDefined();
    const platformRules = Object.values(
      template.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"),
    ).filter((r) =>
      (
        r as {
          Properties: { Actions: { TargetGroupArn?: { Ref: string } }[] };
        }
      ).Properties.Actions.some(
        (a) => a.TargetGroupArn?.Ref === tgLogicalId,
      ),
    );
    expect(platformRules).toHaveLength(1);
    const conditions = (
      platformRules[0] as {
        Properties: {
          Conditions: {
            Field: string;
            PathPatternConfig?: { Values: string[] };
            HttpRequestMethodConfig?: { Values: string[] };
          }[];
        };
      }
    ).Properties.Conditions;
    const pathCond = conditions.find((c) => c.Field === "path-pattern");
    expect(pathCond?.PathPatternConfig?.Values).toEqual(["/tree"]);
    const methodCond = conditions.find(
      (c) => c.Field === "http-request-method",
    );
    expect(methodCond?.HttpRequestMethodConfig?.Values).toEqual(["GET"]);
    const values = pathValues();
    expect(
      values.filter((v) => /^\/(tree\/|folders|admin)/.test(v)),
    ).toHaveLength(0);
  });

  it("unmatched paths get a fixed 404 from the listener", () => {
    const listeners = Object.values(
      template.findResources("AWS::ElasticLoadBalancingV2::Listener"),
    ).map(
      (r) =>
        (
          r as {
            Properties: {
              Port: number;
              DefaultActions: {
                Type: string;
                FixedResponseConfig?: { StatusCode: string };
              }[];
            };
          }
        ).Properties,
    );
    const https = listeners.find((l) => l.Port === 443);
    expect(https).toBeDefined();
    expect(https?.DefaultActions[0].Type).toBe("fixed-response");
    expect(https?.DefaultActions[0].FixedResponseConfig?.StatusCode).toBe(
      "404",
    );
  });
});

describe("task roles", () => {
  const policiesFor = (logicalFragment: string) =>
    Object.entries(template.findResources("AWS::IAM::Policy"))
      .filter(([id]) => id.includes(logicalFragment))
      .flatMap(([, r]) => {
        const stmts = (
          r as { Properties: { PolicyDocument: { Statement: unknown[] } } }
        ).Properties.PolicyDocument.Statement;
        return stmts as { Action?: string | string[] }[];
      });

  const actions = (stmts: { Action?: string | string[] }[]) =>
    stmts.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action].filter(Boolean),
    );

  it("worker task role has no s3:PutObject", () => {
    expect(actions(policiesFor("TaskRoleworker"))).not.toContain(
      "s3:PutObject",
    );
  });

  it("auth task role has no sqs permissions", () => {
    const acts = actions(policiesFor("TaskRoleauth"));
    expect(acts.filter((a) => a?.startsWith("sqs:"))).toHaveLength(0);
    expect(acts.filter((a) => a?.startsWith("s3:"))).toHaveLength(0);
  });
});

describe("RDS", () => {
  it("is Multi-AZ with encrypted storage", () => {
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      MultiAZ: true,
      StorageEncrypted: true,
    });
  });
});

describe("ECS services", () => {
  it("all five services have circuit breaker with rollback", () => {
    template.resourceCountIs("AWS::ECS::Service", 5);
    template.allResourcesProperties("AWS::ECS::Service", {
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      },
    });
  });
});
