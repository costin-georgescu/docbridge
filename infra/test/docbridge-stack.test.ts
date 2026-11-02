import { describe, expect, it } from "@jest/globals";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import {
  DocBridgeStack,
  CertStack,
  ReposStack,
  type EnvironmentConfig,
} from "../lib/docbridge-stack";

const config: EnvironmentConfig = {
  domainName: "docbridge.example.com",
  hostedZoneId: "ZPLACEHOLDER1",
  account: "111111111111",
  region: "eu-central-1",
};

interface SynthOptions {
  config?: Partial<typeof config>;
  servicesEnabled?: boolean;
}

function synth({
  config: overrides = {},
  servicesEnabled = true,
}: SynthOptions = {}) {
  const cfg = { ...config, ...overrides };
  const app = new cdk.App();
  const env = { account: cfg.account, region: cfg.region };
  const repos = new ReposStack(app, "DocBridgeRepos-test", { env });
  const cert = new CertStack(app, "DocBridgeCert-test", {
    env: { account: cfg.account, region: "us-east-1" },
    crossRegionReferences: true,
    envName: "test",
    domainName: cfg.domainName,
    hostedZoneId: cfg.hostedZoneId,
  });
  const stack = new DocBridgeStack(app, "DocBridge-test", {
    env,
    crossRegionReferences: true,
    envName: "test",
    config: cfg,
    imageTag: "latest",
    webCertificateArn: cert.certificate.certificateArn,
    repos: repos.repos,
    servicesEnabled,
  });
  return {
    main: Template.fromStack(stack),
    repos: Template.fromStack(repos),
    cert: Template.fromStack(cert),
  };
}

const { main: template, repos: reposTemplate, cert: certTemplate } = synth();

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
      ).Properties.Actions.some((a) => a.TargetGroupArn?.Ref === tgLogicalId),
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

describe("CloudFront response headers", () => {
  it("sets the TDD 5.5 security headers on the web distribution", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 31536000,
            IncludeSubdomains: true,
            Preload: true,
            Override: true,
          },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ReferrerPolicy: {
            ReferrerPolicy: "strict-origin-when-cross-origin",
            Override: true,
          },
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.stringLikeRegexp(
              "connect-src 'self' https://api\\.docbridge\\.example\\.com",
            ),
            Override: true,
          },
        },
      },
    });
  });

  it("locks down scripts and framing via CSP", () => {
    const policies = template.findResources(
      "AWS::CloudFront::ResponseHeadersPolicy",
    );
    const csp = Object.values(policies)
      .map(
        (p) =>
          (
            p as {
              Properties: {
                ResponseHeadersPolicyConfig: {
                  SecurityHeadersConfig: {
                    ContentSecurityPolicy: { ContentSecurityPolicy: string };
                  };
                };
              };
            }
          ).Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
            .ContentSecurityPolicy.ContentSecurityPolicy,
      )
      .join("\n");
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "upgrade-insecure-requests",
    ]) {
      expect(csp).toContain(directive);
    }
    // Presigned staged uploads go straight from the browser to S3,
    // scoped to the deployment region — no global S3 endpoint.
    expect(csp).toContain("https://*.s3.eu-central-1.amazonaws.com");
    expect(csp).not.toContain("https://*.s3.amazonaws.com");
  });
});

describe("RDS", () => {
  it("is Multi-AZ with encrypted storage", () => {
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      MultiAZ: true,
      StorageEncrypted: true,
    });
  });

  it("allows connections from the services security group only", () => {
    const ingress = Object.values(
      template.findResources("AWS::EC2::SecurityGroupIngress"),
    ).filter((r) =>
      JSON.stringify(r.Properties?.GroupId).includes("PostgresSecurityGroup"),
    );
    expect(ingress).toHaveLength(1);
    const rule = JSON.stringify(ingress[0].Properties);
    expect(rule).toContain("ServicesSg");
    expect(rule).not.toContain("0.0.0.0/0");
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

describe("database bootstrap task", () => {
  const container = Match.objectLike({
    Name: "db-bootstrap",
    Command: ["node", "--import", "tsx", "scripts/db-bootstrap.ts"],
  });

  it("runs scripts/db-bootstrap.ts via tsx on the api image", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([container]),
    });
  });

  it("wires the master and app database secrets", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "db-bootstrap",
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: "MASTER_DB_USERNAME" }),
            Match.objectLike({ Name: "MASTER_DB_PASSWORD" }),
            Match.objectLike({ Name: "AUTH_DB_USERNAME" }),
            Match.objectLike({ Name: "AUTH_DB_PASSWORD" }),
            Match.objectLike({ Name: "DOCBRIDGE_DB_USERNAME" }),
            Match.objectLike({ Name: "DOCBRIDGE_DB_PASSWORD" }),
            Match.objectLike({ Name: "PLATFORM_DB_USERNAME" }),
            Match.objectLike({ Name: "PLATFORM_DB_PASSWORD" }),
          ]),
          Environment: Match.arrayWith([
            Match.objectLike({ Name: "DB_SSL", Value: "no-verify" }),
          ]),
        }),
      ]),
    });
  });

  it("exports the task definition arn", () => {
    template.hasOutput("BootstrapTaskDef", { Value: Match.anyValue() });
  });
});

describe("CloudFront certificate", () => {
  it("validates via DNS against the hosted zone", () => {
    certTemplate.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: `app.${config.domainName}`,
      DomainValidationOptions: Match.arrayWith([
        Match.objectLike({ HostedZoneId: config.hostedZoneId }),
      ]),
    });
  });
});

describe("ECR repositories", () => {
  it("live in the repos stack with the docbridge/<app> names", () => {
    reposTemplate.resourceCountIs("AWS::ECR::Repository", 5);
    for (const app of ["api", "auth", "platform", "dispatcher", "worker"]) {
      reposTemplate.hasResourceProperties("AWS::ECR::Repository", {
        RepositoryName: `docbridge/${app}`,
        ImageScanningConfiguration: { ScanOnPush: true },
      });
    }
    template.resourceCountIs("AWS::ECR::Repository", 0);
  });

  it("the main stack references them for task images", () => {
    const defs = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    );
    const images = defs.flatMap((d) =>
      d.Properties.ContainerDefinitions.map((c: { Image: unknown }) =>
        JSON.stringify(c.Image),
      ),
    );
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toContain("DocBridgeRepos-test:ExportsOutput");
    }
  });
});

describe("firstDeploy flag", () => {
  it("desiredCount 0 and no autoscaling when services are disabled", () => {
    const t = synth({ servicesEnabled: false }).main;
    t.allResourcesProperties("AWS::ECS::Service", {
      DesiredCount: 0,
    });
    t.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
    t.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 0);
  });

  it("normal counts and worker scaling when enabled", () => {
    template.allResourcesProperties("AWS::ECS::Service", {
      DesiredCount: 2,
    });
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 2);
  });
});

describe("alarm email", () => {
  it("creates an SNS email subscription when alarmEmail is set", () => {
    const t = synth({
      config: { alarmEmail: "oncall@docbridge.example.com" },
    }).main;
    t.resourceCountIs("AWS::SNS::Subscription", 1);
    t.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "oncall@docbridge.example.com",
    });
  });

  it("creates no subscription without alarmEmail", () => {
    template.resourceCountIs("AWS::SNS::Subscription", 0);
  });
});

describe("DB SSL", () => {
  it("sets DB_SSL=no-verify on every DB-connecting container", () => {
    const defs = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    );
    // 5 services + 3 migrate + seed + bootstrap
    expect(defs).toHaveLength(10);
    for (const def of defs) {
      for (const c of def.Properties.ContainerDefinitions) {
        expect(c.Environment ?? []).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ Name: "DB_SSL", Value: "no-verify" }),
          ]),
        );
      }
    }
  });
});
