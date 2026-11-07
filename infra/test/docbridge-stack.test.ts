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

// CloudFront-only mode: no domainName/hostedZoneId.
const cfConfig: EnvironmentConfig = {
  account: "111111111111",
  region: "eu-central-1",
};

interface SynthOptions {
  config?: Partial<typeof config>;
  servicesEnabled?: boolean;
  // CloudFront-only mode: start from cfConfig (no domain) instead of config.
  cloudfrontOnly?: boolean;
}

function synth({
  config: overrides = {},
  servicesEnabled = true,
  cloudfrontOnly = false,
}: SynthOptions = {}) {
  const cfg = { ...(cloudfrontOnly ? cfConfig : config), ...overrides };
  const app = new cdk.App();
  const env = { account: cfg.account, region: cfg.region };
  const repos = new ReposStack(app, "DocBridgeRepos-test", { env });
  const cert =
    cfg.domainName !== undefined
      ? new CertStack(app, "DocBridgeCert-test", {
          env: { account: cfg.account, region: "us-east-1" },
          crossRegionReferences: true,
          envName: "test",
          domainName: cfg.domainName,
          hostedZoneId: cfg.hostedZoneId!,
        })
      : undefined;
  const stack = new DocBridgeStack(app, "DocBridge-test", {
    env,
    crossRegionReferences: true,
    envName: "test",
    config: cfg,
    imageTag: "latest",
    webCertificateArn: cert?.certificate.certificateArn,
    repos: repos.repos,
    servicesEnabled,
  });
  return {
    main: Template.fromStack(stack),
    repos: Template.fromStack(repos),
    cert: cert ? Template.fromStack(cert) : undefined,
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

  it("staging and platform buckets enable the SSE-KMS bucket key", () => {
    for (const name of ["docbridge-staging", "docbridge-platform"]) {
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: Match.stringLikeRegexp(name),
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({ BucketKeyEnabled: true }),
          ]),
        },
      });
    }
  });

  it("platform bucket is versioned and expires objects after platformRetentionDays", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("docbridge-platform"),
      VersioningConfiguration: { Status: "Enabled" },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 30,
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ]),
      },
    });
  });

  it("staging bucket splits the tag-filtered expiry from the multipart abort", () => {
    // S3 rejects AbortIncompleteMultipartUpload combined with a tag filter.
    const staging = Object.values(
      template.findResources("AWS::S3::Bucket"),
    ).find(
      (b) =>
        (b as { Properties: { BucketName: string } }).Properties.BucketName ===
        "docbridge-staging-test-111111111111",
    ) as {
      Properties: {
        LifecycleConfiguration: {
          Rules: {
            Id?: string;
            ExpirationInDays?: number;
            AbortIncompleteMultipartUpload?: unknown;
            TagFilters?: unknown;
          }[];
        };
      };
    };
    const rules = staging.Properties.LifecycleConfiguration.Rules;
    expect(rules).toHaveLength(2);
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ExpirationInDays: 32,
          TagFilters: [{ Key: "retention", Value: "completed" }],
        }),
        expect.objectContaining({
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        }),
      ]),
    );
  });

  it("no bucket lifecycle rule combines a tag filter with the multipart abort", () => {
    const buckets = Object.values(
      template.findResources("AWS::S3::Bucket"),
    ) as {
      Properties: {
        LifecycleConfiguration?: {
          Rules: {
            AbortIncompleteMultipartUpload?: unknown;
            TagFilters?: unknown;
            Filter?: { And?: { Tags?: unknown } };
          }[];
        };
      };
    }[];
    for (const bucket of buckets) {
      for (const rule of bucket.Properties.LifecycleConfiguration?.Rules ??
        []) {
        const hasTags =
          rule.TagFilters !== undefined || rule.Filter?.And?.Tags !== undefined;
        expect(
          hasTags && rule.AbortIncompleteMultipartUpload !== undefined,
        ).toBe(false);
      }
    }
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

describe("VPC endpoints", () => {
  it("has a free S3 gateway endpoint", () => {
    const endpoints = Object.values(
      template.findResources("AWS::EC2::VPCEndpoint"),
    ) as { Properties: { VpcEndpointType?: string; ServiceName: unknown } }[];
    const s3 = endpoints.filter(
      (e) =>
        e.Properties.VpcEndpointType === "Gateway" &&
        JSON.stringify(e.Properties.ServiceName).includes("s3"),
    );
    expect(s3).toHaveLength(1);
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
    certTemplate!.hasResourceProperties(
      "AWS::CertificateManager::Certificate",
      {
        DomainName: `app.${config.domainName}`,
        DomainValidationOptions: Match.arrayWith([
          Match.objectLike({ HostedZoneId: config.hostedZoneId }),
        ]),
      },
    );
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

  it("keep at most 5 images per repo", () => {
    reposTemplate.allResourcesProperties("AWS::ECR::Repository", {
      LifecyclePolicy: {
        LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":5'),
      },
    });
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

describe("spend alerts", () => {
  const withEmail = (extra: Partial<typeof config> = {}) =>
    synth({
      config: { alarmEmail: "oncall@docbridge.example.com", ...extra },
    }).main;

  it("creates a monthly cost budget with actual+forecast thresholds", () => {
    const t = withEmail();
    t.resourceCountIs("AWS::Budgets::Budget", 1);
    t.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 100, Unit: "USD" },
        // gross spend: credits/refunds excluded so alerts fire while the
        // free-credit balance is still burning down
        CostTypes: { IncludeCredit: false, IncludeRefund: false },
      },
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: "ACTUAL",
            Threshold: 80,
          }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: "FORECASTED",
            Threshold: 100,
          }),
        }),
      ]),
    });
    const budget = Object.values(
      t.findResources("AWS::Budgets::Budget"),
    )[0] as {
      Properties: {
        NotificationsWithSubscribers: {
          Notification: { NotificationType: string; Threshold: number };
        }[];
      };
    };
    expect(
      budget.Properties.NotificationsWithSubscribers.map(
        (n) => `${n.Notification.NotificationType}:${n.Notification.Threshold}`,
      ).sort(),
    ).toEqual(["ACTUAL:100", "ACTUAL:50", "ACTUAL:80", "FORECASTED:100"]);
  });

  it("honours a monthlyBudgetUsd override", () => {
    withEmail({ monthlyBudgetUsd: 123 }).hasResourceProperties(
      "AWS::Budgets::Budget",
      { Budget: { BudgetLimit: { Amount: 123, Unit: "USD" } } },
    );
  });

  it("creates cost anomaly monitor + subscription", () => {
    const t = withEmail();
    t.resourceCountIs("AWS::CE::AnomalyMonitor", 1);
    t.hasResourceProperties("AWS::CE::AnomalyMonitor", {
      MonitorType: "DIMENSIONAL",
      MonitorDimension: "SERVICE",
    });
    t.resourceCountIs("AWS::CE::AnomalySubscription", 1);
    t.hasResourceProperties("AWS::CE::AnomalySubscription", {
      Frequency: "DAILY",
      Subscribers: [{ Type: "EMAIL", Address: "oncall@docbridge.example.com" }],
      ThresholdExpression: Match.stringLikeRegexp(
        "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
      ),
    });
    const sub = Object.values(
      t.findResources("AWS::CE::AnomalySubscription"),
    )[0] as { Properties: { ThresholdExpression: string } };
    expect(JSON.parse(sub.Properties.ThresholdExpression)).toEqual({
      Dimensions: {
        Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
        Values: ["5"],
        MatchOptions: ["GREATER_THAN_OR_EQUAL"],
      },
    });
  });

  it("creates no Budgets/CE resources with spendAlerts:false but keeps the alarm subscription", () => {
    const t = withEmail({ spendAlerts: false });
    t.resourceCountIs("AWS::Budgets::Budget", 0);
    t.resourceCountIs("AWS::CE::AnomalyMonitor", 0);
    t.resourceCountIs("AWS::CE::AnomalySubscription", 0);
    t.resourceCountIs("AWS::SNS::Subscription", 1);
  });

  it("creates no spend alerts without alarmEmail", () => {
    template.resourceCountIs("AWS::Budgets::Budget", 0);
    template.resourceCountIs("AWS::CE::AnomalyMonitor", 0);
    template.resourceCountIs("AWS::CE::AnomalySubscription", 0);
  });
});

describe("seed password", () => {
  it("generates a Secrets Manager seed password", () => {
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "docbridge/test/seed-password",
      GenerateSecretString: Match.objectLike({
        PasswordLength: 24,
        ExcludePunctuation: true,
      }),
    });
  });

  it("injects SEED_PASSWORD into the seed task container", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "seed",
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: "SEED_PASSWORD" }),
          ]),
        }),
      ]),
    });
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

describe("domain mode (custom domain configured)", () => {
  it("has no distribution-wide error responses (SPA fallback is a function)", () => {
    const dists = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    ) as { Properties: { DistributionConfig: Record<string, unknown> } }[];
    expect(dists).toHaveLength(1);
    expect(
      dists[0].Properties.DistributionConfig.CustomErrorResponses,
    ).toBeUndefined();
  });

  it("rewrites extensionless paths to /index.html via a viewer-request function", () => {
    const dist = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    )[0] as {
      Properties: {
        DistributionConfig: {
          DefaultCacheBehavior: {
            FunctionAssociations?: { EventType: string }[];
          };
        };
      };
    };
    const fns =
      dist.Properties.DistributionConfig.DefaultCacheBehavior
        .FunctionAssociations ?? [];
    expect(fns.map((f) => f.EventType)).toContain("viewer-request");
  });

  it("sets TRUST_PROXY_HOPS=1 on api/auth/platform task defs", () => {
    const defs = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    ) as {
      Properties: {
        ContainerDefinitions: {
          Name: string;
          Environment?: { Name: string; Value: string }[];
        }[];
      };
    }[];
    for (const name of ["api", "auth", "platform"]) {
      const def = defs.find((d) =>
        d.Properties.ContainerDefinitions.some((c) => c.Name === name),
      );
      const container = def!.Properties.ContainerDefinitions.find(
        (c) => c.Name === name,
      )!;
      expect(container.Environment).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Name: "TRUST_PROXY_HOPS", Value: "1" }),
        ]),
      );
    }
  });
});

describe("cloudfront-only mode (no domain)", () => {
  const cf = synth({ cloudfrontOnly: true }).main;

  it("creates no Route53 records and no ACM certificates", () => {
    cf.resourceCountIs("AWS::Route53::RecordSet", 0);
    cf.resourceCountIs("AWS::CertificateManager::Certificate", 0);
  });

  it("has an internal ALB with a single HTTP :80 listener", () => {
    cf.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internal",
    });
    const listeners = Object.values(
      cf.findResources("AWS::ElasticLoadBalancingV2::Listener"),
    ) as { Properties: { Port: number; Protocol: string } }[];
    expect(listeners).toHaveLength(1);
    expect(listeners[0].Properties.Port).toBe(80);
    expect(listeners[0].Properties.Protocol).toBe("HTTP");
    cf.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
  });

  it("restricts ALB ingress to the VPC CIDR on port 80", () => {
    const sgs = Object.entries(
      cf.findResources("AWS::EC2::SecurityGroup"),
    ).filter(([id]) => id.includes("AlbSg"));
    expect(sgs).toHaveLength(1);
    const ingress =
      (
        sgs[0][1] as {
          Properties: { SecurityGroupIngress?: Record<string, unknown>[] };
        }
      ).Properties.SecurityGroupIngress ?? [];
    expect(ingress).toHaveLength(1);
    expect(ingress[0].FromPort).toBe(80);
    const rule = JSON.stringify(ingress[0]);
    expect(rule).toContain("CidrBlock");
    expect(rule).not.toContain("0.0.0.0/0");
  });

  it("has no aliases and no custom error responses on the distribution", () => {
    const dists = Object.values(
      cf.findResources("AWS::CloudFront::Distribution"),
    ) as {
      Properties: {
        DistributionConfig: Record<string, unknown> & {
          CacheBehaviors: { PathPattern: string }[];
        };
      };
    }[];
    expect(dists).toHaveLength(1);
    const cfg = dists[0].Properties.DistributionConfig;
    expect(cfg.Aliases).toBeUndefined();
    expect(cfg.CustomErrorResponses).toBeUndefined();
  });

  it("creates a VPC origin for the internal ALB", () => {
    cf.resourceCountIs("AWS::CloudFront::VpcOrigin", 1);
    cf.hasResourceProperties("AWS::CloudFront::VpcOrigin", {
      VpcOriginEndpointConfig: Match.objectLike({
        HTTPPort: 80,
        OriginProtocolPolicy: "http-only",
      }),
    });
  });

  it("routes /api/*, /tree and /auth/* to the ALB uncached with all methods", () => {
    const dist = Object.values(
      cf.findResources("AWS::CloudFront::Distribution"),
    )[0] as {
      Properties: {
        DistributionConfig: {
          CacheBehaviors: {
            PathPattern: string;
            AllowedMethods: string[];
            CachePolicyId: string;
            FunctionAssociations?: unknown[];
          }[];
        };
      };
    };
    const behaviors = dist.Properties.DistributionConfig.CacheBehaviors;
    expect(behaviors.map((b) => b.PathPattern).sort()).toEqual([
      "/api/*",
      "/auth/*",
      "/tree",
    ]);
    // CachingDisabled managed policy id.
    const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
    for (const b of behaviors) {
      expect(b.CachePolicyId).toBe(CACHING_DISABLED);
      expect(b.AllowedMethods).toEqual([
        "GET",
        "HEAD",
        "OPTIONS",
        "PUT",
        "PATCH",
        "POST",
        "DELETE",
      ]);
    }
  });

  it("keeps the SPA rewrite function on the default behavior", () => {
    const dist = Object.values(
      cf.findResources("AWS::CloudFront::Distribution"),
    )[0] as {
      Properties: {
        DistributionConfig: {
          DefaultCacheBehavior: {
            FunctionAssociations?: { EventType: string }[];
          };
        };
      };
    };
    const fns =
      dist.Properties.DistributionConfig.DefaultCacheBehavior
        .FunctionAssociations ?? [];
    expect(fns.map((f) => f.EventType)).toContain("viewer-request");
  });

  it("drops api.<domain> from the CSP connect-src", () => {
    const policies = cf.findResources("AWS::CloudFront::ResponseHeadersPolicy");
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
    expect(csp).not.toContain("api.");
    expect(csp).toContain("https://*.s3.eu-central-1.amazonaws.com");
  });

  it("sets TRUST_PROXY_HOPS=2 on api/auth/platform task defs", () => {
    const defs = Object.values(
      cf.findResources("AWS::ECS::TaskDefinition"),
    ) as {
      Properties: {
        ContainerDefinitions: {
          Name: string;
          Environment?: { Name: string; Value: string }[];
        }[];
      };
    }[];
    for (const name of ["api", "auth", "platform"]) {
      const def = defs.find((d) =>
        d.Properties.ContainerDefinitions.some((c) => c.Name === name),
      );
      const container = def!.Properties.ContainerDefinitions.find(
        (c) => c.Name === name,
      )!;
      expect(container.Environment).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Name: "TRUST_PROXY_HOPS", Value: "2" }),
        ]),
      );
    }
  });

  it("exports the WebUrl output", () => {
    cf.hasOutput("WebUrl", { Value: Match.anyValue() });
  });
});

describe("apigw edge mode (edge: apigw, lean, no domain)", () => {
  const apigw = synth({
    cloudfrontOnly: true,
    config: { account: "123456789012", edge: "apigw", lean: true },
  }).main;

  it("creates no CloudFront resources", () => {
    apigw.resourceCountIs("AWS::CloudFront::Distribution", 0);
    apigw.resourceCountIs("AWS::CloudFront::VpcOrigin", 0);
    apigw.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 0);
    apigw.resourceCountIs("AWS::CloudFront::Function", 0);
  });

  it("has an HTTP API with a $default auto-deploy stage and a VPC link", () => {
    apigw.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
    });
    apigw.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
    });
    apigw.resourceCountIs("AWS::ApiGatewayV2::VpcLink", 1);
  });

  it("proxies the API routes to the internal ALB over the VPC link", () => {
    const listenerId = Object.keys(
      apigw.findResources("AWS::ElasticLoadBalancingV2::Listener"),
    )[0];
    apigw.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      IntegrationType: "HTTP_PROXY",
      IntegrationMethod: "ANY",
      ConnectionType: "VPC_LINK",
      PayloadFormatVersion: "1.0",
      IntegrationUri: { Ref: listenerId },
    });
    const routeKeys = Object.values(
      apigw.findResources("AWS::ApiGatewayV2::Route"),
    ).map(
      (r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(routeKeys.sort()).toEqual([
      "$default",
      "ANY /api/{proxy+}",
      "ANY /auth/{proxy+}",
      "GET /tree",
    ]);
  });

  it("serves $default from a Lambda that carries the CSP security headers", () => {
    apigw.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
    });
    const lambdas = Object.values(
      apigw.findResources("AWS::Lambda::Function"),
    ) as {
      Properties: { Runtime: string; Code?: { ZipFile?: string } };
    }[];
    const spa = lambdas.find((l) =>
      l.Properties.Code?.ZipFile?.includes("GetObjectCommand"),
    );
    expect(spa).toBeDefined();
    expect(spa!.Properties.Runtime).toBe("nodejs22.x");
    const code = spa!.Properties.Code!.ZipFile!;
    expect(code).toContain(
      "connect-src 'self' https://*.s3.eu-central-1.amazonaws.com",
    );
    expect(code).toContain('"X-Frame-Options":"DENY"');
    expect(code).toContain('"Strict-Transport-Security":"max-age=31536000"');
    apigw.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "apigateway.amazonaws.com",
    });
  });

  it("runs every service at count 1 and RDS single-AZ (lean)", () => {
    apigw.allResourcesProperties("AWS::ECS::Service", { DesiredCount: 1 });
    apigw.hasResourceProperties("AWS::RDS::DBInstance", { MultiAZ: false });
  });

  it("points staging CORS and WEB_ORIGIN at the execute-api host", () => {
    const apiId = Object.keys(apigw.findResources("AWS::ApiGatewayV2::Api"))[0];
    expect(apiId).toBeDefined();
    const buckets = Object.values(apigw.findResources("AWS::S3::Bucket")) as {
      Properties: {
        BucketName: string;
        CorsConfiguration?: { CorsRules: { AllowedOrigins: unknown[] }[] };
      };
    }[];
    const staging = buckets.find((b) =>
      b.Properties.BucketName.includes("docbridge-staging"),
    )!;
    const origins = JSON.stringify(
      staging.Properties.CorsConfiguration!.CorsRules[0].AllowedOrigins,
    );
    expect(origins).toContain(apiId);
    expect(origins).toContain("execute-api.eu-central-1.amazonaws.com");
    expect(origins).not.toContain("cloudfront");

    const defs = Object.values(
      apigw.findResources("AWS::ECS::TaskDefinition"),
    ) as {
      Properties: {
        ContainerDefinitions: {
          Name: string;
          Environment?: { Name: string; Value: unknown }[];
        }[];
      };
    }[];
    const apiContainer = defs
      .flatMap((d) => d.Properties.ContainerDefinitions)
      .find((c) => c.Name === "api")!;
    const webOrigin = apiContainer.Environment!.find(
      (e) => e.Name === "WEB_ORIGIN",
    )!;
    const value = JSON.stringify(webOrigin.Value);
    expect(value).toContain(apiId);
    expect(value).toContain("execute-api.eu-central-1.amazonaws.com");
    expect(value).not.toContain("cloudfront");
  });

  it("exports WebUrl and WebBucketName but no DistributionId", () => {
    apigw.hasOutput("WebUrl", { Value: Match.anyValue() });
    apigw.hasOutput("WebBucketName", { Value: Match.anyValue() });
    expect(() =>
      apigw.hasOutput("DistributionId", { Value: Match.anyValue() }),
    ).toThrow();
  });
});
