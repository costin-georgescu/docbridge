import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as r53targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";

export interface EnvironmentConfig {
  domainName: string;
  hostedZoneId: string;
  account: string;
  region: string;
}

interface ServiceSize {
  cpu: number;
  memoryMiB: number;
  count: number;
}

// TDD 9.2: one set of sizes for all environments in R1.
const Parameters = {
  services: {
    api: { cpu: 512, memoryMiB: 1024, count: 2 },
    auth: { cpu: 256, memoryMiB: 512, count: 2 },
    platform: { cpu: 1024, memoryMiB: 2048, count: 2 },
    dispatcher: { cpu: 256, memoryMiB: 512, count: 2 },
    worker: { cpu: 1024, memoryMiB: 2048, count: 2 },
  } satisfies Record<string, ServiceSize>,
  workerMaxCount: 20,
  workerBacklogPerTask: 10,
  rdsInstanceType: "t4g.medium",
  stagedRetentionDays: 32,
  multipartAbortDays: 7,
} as const;

const SERVICE_PORTS: Record<string, number> = {
  api: 3000,
  auth: 3001,
  platform: 3002,
};

/** CloudFront certificate holder — certificates for CloudFront must be in us-east-1. */
export class CertStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  constructor(
    scope: Construct,
    id: string,
    props: cdk.StackProps & { envName: string; domainName: string },
  ) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, "WebCertificate", {
      domainName: `app.${props.domainName}`,
      validation: acm.CertificateValidation.fromDns(),
    });
  }
}

export interface DocBridgeStackProps extends cdk.StackProps {
  envName: string;
  config: EnvironmentConfig;
  imageTag: string;
  webCertificateArn: string;
}

export class DocBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DocBridgeStackProps) {
    super(scope, id, props);
    const { envName, config } = props;
    const domain = config.domainName;
    const webOrigin = `https://app.${domain}`;

    // ---------- Network ----------
    // One NAT gateway keeps cost down; add a second for real HA later.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // ---------- DNS + certificates ----------
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: config.hostedZoneId,
      zoneName: domain,
    });
    const albCertificate = new acm.Certificate(this, "AlbCertificate", {
      domainName: `api.${domain}`,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const webCertificate = acm.Certificate.fromCertificateArn(
      this,
      "WebCertificate",
      props.webCertificateArn,
    );

    // ---------- KMS ----------
    const stagingKey = new kms.Key(this, "StagingKey", {
      enableKeyRotation: true,
    });
    const platformKey = new kms.Key(this, "PlatformKey", {
      enableKeyRotation: true,
    });
    const rdsKey = new kms.Key(this, "RdsKey", { enableKeyRotation: true });
    // Secrets Manager values are encrypted with this CMK; task roles get
    // kms:Decrypt on it in addition to secretsmanager:GetSecretValue.
    const secretsKey = new kms.Key(this, "SecretsKey", {
      enableKeyRotation: true,
    });

    // ---------- Queues ----------
    const tasksDlq = new sqs.Queue(this, "TasksDlq", {
      queueName: `docbridge-tasks-dlq-${envName}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const tasksQueue = new sqs.Queue(this, "TasksQueue", {
      queueName: `docbridge-tasks-${envName}`,
      visibilityTimeout: cdk.Duration.seconds(1200),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: tasksDlq, maxReceiveCount: 3 },
    });
    const uploadEventsDlq = new sqs.Queue(this, "UploadEventsDlq", {
      queueName: `docbridge-upload-events-dlq-${envName}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const uploadEventsQueue = new sqs.Queue(this, "UploadEventsQueue", {
      queueName: `docbridge-upload-events-${envName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: uploadEventsDlq, maxReceiveCount: 5 },
    });

    // ---------- Buckets ----------
    const stagingBucket = new s3.Bucket(this, "StagingBucket", {
      bucketName: `docbridge-staging-${envName}-${config.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: stagingKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [
        {
          allowedOrigins: [webOrigin],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
        },
      ],
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(
            Parameters.multipartAbortDays,
          ),
          expiration: cdk.Duration.days(Parameters.stagedRetentionDays),
          tagFilters: { retention: "completed" },
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    stagingBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.SqsDestination(uploadEventsQueue),
      { prefix: "staged/" },
    );
    stagingBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_COMPLETE_MULTIPART_UPLOAD,
      new s3n.SqsDestination(uploadEventsQueue),
      { prefix: "staged/" },
    );

    const platformBucket = new s3.Bucket(this, "PlatformBucket", {
      bucketName: `docbridge-platform-${envName}-${config.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: platformKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: `docbridge-web-${envName}-${config.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------- Secrets ----------
    // The role/database creation itself is an operational bootstrap step
    // (SQL or a one-off task); these hold the generated app-role credentials.
    const dbSecrets = Object.fromEntries(
      (["auth", "docbridge", "platform"] as const).map((name) => [
        name,
        new secrets.Secret(this, `DbSecret-${name}`, {
          secretName: `docbridge/${envName}/db/${name}`,
          encryptionKey: secretsKey,
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: `${name}_app` }),
            generateStringKey: "password",
            excludePunctuation: true,
          },
        }),
      ]),
    );
    // Signing keypair is populated manually at environment bring-up.
    const jwtSecret = new secrets.Secret(this, "JwtSigningKey", {
      secretName: `docbridge/${envName}/auth/jwt-signing-key`,
      encryptionKey: secretsKey,
      description: "RS256 keypair for token signing; populated manually",
    });
    const workerSecret = new secrets.Secret(this, "WorkerClientSecret", {
      secretName: `docbridge/${envName}/auth/worker-client-secret`,
      encryptionKey: secretsKey,
      generateSecretString: { excludePunctuation: true },
    });

    // ---------- RDS ----------
    const db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of("17.11", "17"),
      }),
      instanceType: new ec2.InstanceType(Parameters.rdsInstanceType),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      multiAz: true,
      storageEncrypted: true,
      storageEncryptionKey: rdsKey,
      parameters: { "rds.force_ssl": "1" },
      credentials: rds.Credentials.fromGeneratedSecret("postgres"),
      deletionProtection: envName === "production",
      removalPolicy:
        envName === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // ---------- ECR ----------
    const repos = Object.fromEntries(
      ["api", "auth", "platform", "dispatcher", "worker"].map((name) => [
        name,
        new ecr.Repository(this, `Repo-${name}`, {
          repositoryName: `docbridge/${name}`,
          imageScanOnPush: true,
          lifecycleRules: [{ maxImageCount: 20 }],
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          emptyOnDelete: true,
        }),
      ]),
    );

    // ---------- ECS cluster + Cloud Map ----------
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    cluster.addDefaultCloudMapNamespace({
      name: "docbridge.local",
      type: servicediscovery.NamespaceType.DNS_PRIVATE,
      vpc,
    });

    // Shared execution role: ECR pull, secret injection, log writes.
    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });
    secretsKey.grantDecrypt(executionRole);
    for (const s of [jwtSecret, workerSecret, ...Object.values(dbSecrets)]) {
      s.grantRead(executionRole);
    }

    // ---------- ALB ----------
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });
    alb.addRedirect({ sourcePort: 80, targetPort: 443 });
    const listener = alb.addListener("HttpsListener", {
      port: 443,
      certificates: [albCertificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "application/json",
        messageBody: JSON.stringify({
          error: { code: "not_found", message: "route not found" },
        }),
      }),
    });

    // ---------- Services ----------
    const servicesSg = new ec2.SecurityGroup(this, "ServicesSg", { vpc });
    const serviceNames = [
      "api",
      "auth",
      "platform",
      "dispatcher",
      "worker",
    ] as const;
    type ServiceName = (typeof serviceNames)[number];

    const taskRoles: Record<ServiceName, iam.Role> = Object.fromEntries(
      serviceNames.map((n) => [
        n,
        new iam.Role(this, `TaskRole-${n}`, {
          assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        }),
      ]),
    ) as Record<ServiceName, iam.Role>;

    // IAM per TDD 6.3 (least privilege).
    const stagedPrefix = `${stagingBucket.bucketArn}/staged/*`;
    const versionsPrefix = `${platformBucket.bucketArn}/versions/*`;

    taskRoles.api.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [stagedPrefix],
      }),
    );
    stagingKey.grant(taskRoles.api, "kms:GenerateDataKey", "kms:Decrypt");

    taskRoles.dispatcher.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObjectTagging", "s3:DeleteObject"],
        resources: [stagedPrefix],
      }),
    );
    uploadEventsQueue.grant(
      taskRoles.dispatcher,
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
    );
    tasksQueue.grant(taskRoles.dispatcher, "sqs:SendMessage");
    stagingKey.grantDecrypt(taskRoles.dispatcher);

    taskRoles.worker.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [stagedPrefix],
      }),
    );
    tasksQueue.grant(
      taskRoles.worker,
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
    );
    stagingKey.grantDecrypt(taskRoles.worker);

    taskRoles.platform.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
        resources: [versionsPrefix],
      }),
    );
    platformKey.grant(taskRoles.platform, "kms:GenerateDataKey", "kms:Decrypt");

    // secretsmanager:GetSecretValue on each role's own secrets + decrypt on
    // the secrets CMK (TDD 6.3).
    const roleSecrets: Record<ServiceName, secrets.ISecret[]> = {
      api: [dbSecrets.docbridge],
      auth: [dbSecrets.auth, jwtSecret, workerSecret],
      platform: [dbSecrets.platform],
      dispatcher: [dbSecrets.docbridge],
      worker: [dbSecrets.docbridge, workerSecret],
    };
    for (const n of serviceNames) {
      for (const s of roleSecrets[n]) s.grantRead(taskRoles[n]);
      secretsKey.grantDecrypt(taskRoles[n]);
    }

    const fargateServices = {} as Record<ServiceName, ecs.FargateService>;
    for (const name of serviceNames) {
      const size = Parameters.services[name];
      const taskDef = new ecs.FargateTaskDefinition(this, `TaskDef-${name}`, {
        cpu: size.cpu,
        memoryLimitMiB: size.memoryMiB,
        taskRole: taskRoles[name],
        executionRole,
      });
      const containerEnv: Record<string, string> = {
        NODE_ENV: "production",
        AWS_REGION: config.region,
        STAGING_BUCKET: stagingBucket.bucketName,
        PLATFORM_BUCKET: platformBucket.bucketName,
        TASKS_QUEUE_URL: tasksQueue.queueUrl,
        UPLOAD_EVENTS_QUEUE_URL: uploadEventsQueue.queueUrl,
        WEB_ORIGIN: webOrigin,
        DB_HOST: db.instanceEndpoint.hostname,
        DB_NAME: {
          api: "docbridge",
          dispatcher: "docbridge",
          worker: "docbridge",
          auth: "auth",
          platform: "platform",
        }[name],
      };
      const containerSecrets: Record<string, ecs.Secret> = {
        DB_USERNAME: ecs.Secret.fromSecretsManager(
          roleSecrets[name][0],
          "username",
        ),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(
          roleSecrets[name][0],
          "password",
        ),
      };
      if (name === "auth") {
        containerSecrets.JWT_SIGNING_KEY =
          ecs.Secret.fromSecretsManager(jwtSecret);
      }
      if (name === "auth" || name === "worker") {
        containerSecrets.WORKER_CLIENT_SECRET =
          ecs.Secret.fromSecretsManager(workerSecret);
      }
      if (name === "api") {
        containerEnv.PLATFORM_INTERNAL_URL =
          "http://platform.docbridge.local:3002";
      }
      if (name === "api" || name === "platform") {
        containerEnv.AUTH_INTERNAL_URL = "http://auth.docbridge.local:3001";
      }
      taskDef.addContainer(`${name}-container`, {
        containerName: name,
        image: ecs.ContainerImage.fromEcrRepository(
          repos[name],
          props.imageTag,
        ),
        environment: containerEnv,
        secrets: containerSecrets,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: name,
          logGroup: new logs.LogGroup(this, `LogGroup-${name}`, {
            logGroupName: `/docbridge/${envName}/${name}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        }),
        portMappings:
          name in SERVICE_PORTS ? [{ containerPort: SERVICE_PORTS[name] }] : [],
        // TDD 2.7: workers finish in-flight attempts on SIGTERM.
        stopTimeout: name === "worker" ? cdk.Duration.seconds(120) : undefined,
      });
      const service = new ecs.FargateService(this, `Service-${name}`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: size.count,
        securityGroups: [servicesSg],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        cloudMapOptions: { name },
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
      });
      if (name in SERVICE_PORTS) {
        servicesSg.addIngressRule(
          albSg,
          ec2.Port.tcp(SERVICE_PORTS[name]),
          `alb-to-${name}`,
        );
      }
      fargateServices[name] = service;
    }

    // service-to-service inside the Cloud Map namespace
    for (const port of Object.values(SERVICE_PORTS)) {
      servicesSg.addIngressRule(servicesSg, ec2.Port.tcp(port));
    }

    // api scales on CPU (TDD 7.x default); worker on queue backlog per task.
    fargateServices.api
      .autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 })
      .scaleOnCpuUtilization("ApiCpu", { targetUtilizationPercent: 60 });

    const workerScaling = fargateServices.worker.autoScaleTaskCount({
      minCapacity: Parameters.services.worker.count,
      maxCapacity: Parameters.workerMaxCount,
    });
    // Target tracking does not support metric math in this CDK version,
    // so the target is raw ApproximateNumberOfMessagesVisible
    // (workerMaxCount * backlog-per-task) rather than backlog per task.
    workerScaling.scaleToTrackCustomMetric("WorkerBacklog", {
      metric: tasksQueue.metricApproximateNumberOfMessagesVisible({
        statistic: "Average",
        period: cdk.Duration.minutes(1),
      }),
      targetValue: Parameters.workerMaxCount * Parameters.workerBacklogPerTask,
    });

    // ---------- ALB targets + rules ----------
    const httpServices = ["api", "auth", "platform"] as const;
    const targetGroups = {} as Record<
      (typeof httpServices)[number],
      elbv2.ApplicationTargetGroup
    >;
    for (const name of httpServices) {
      const tg = new elbv2.ApplicationTargetGroup(this, `TargetGroup-${name}`, {
        vpc,
        port: SERVICE_PORTS[name],
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: { path: "/health" },
      });
      fargateServices[name].attachToApplicationTargetGroup(tg);
      targetGroups[name] = tg;
    }
    listener.addTargetGroups("ApiRule", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/api/*"])],
      targetGroups: [targetGroups.api],
    });
    // The platform's ONLY public route: GET /tree (ADR-14).
    listener.addTargetGroups("PlatformTreeRule", {
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(["/tree"]),
        elbv2.ListenerCondition.httpRequestMethods(["GET"]),
      ],
      targetGroups: [targetGroups.platform],
    });
    // Enumerated auth paths only — /auth/service-token is never public.
    // ALB allows at most 5 path values per rule — split into two rules.
    const authPaths = [
      ["/auth/login", "/auth/refresh", "/auth/logout", "/auth/users"],
      ["/auth/users/*", "/auth/.well-known/*"],
    ];
    authPaths.forEach((paths, i) => {
      listener.addTargetGroups(`AuthRule${i}`, {
        priority: 30 + i,
        conditions: [elbv2.ListenerCondition.pathPatterns(paths)],
        targetGroups: [targetGroups.auth],
      });
    });

    // ---------- CloudFront ----------
    const responseHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
        },
      },
    );
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      domainNames: [`app.${domain}`],
      certificate: webCertificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: responseHeaders,
      },
      // SPA fallback: serve index.html on unknown routes.
      errorResponses: [403, 404].map((code) => ({
        httpStatus: code,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: cdk.Duration.seconds(0),
      })),
    });

    new route53.ARecord(this, "ApiARecord", {
      zone,
      recordName: `api.${domain}`,
      target: route53.RecordTarget.fromAlias(
        new r53targets.LoadBalancerTarget(alb),
      ),
    });
    new route53.AaaaRecord(this, "ApiAaaaRecord", {
      zone,
      recordName: `api.${domain}`,
      target: route53.RecordTarget.fromAlias(
        new r53targets.LoadBalancerTarget(alb),
      ),
    });
    for (const [id, cls] of [
      ["AppARecord", route53.ARecord],
      ["AppAaaaRecord", route53.AaaaRecord],
    ] as const) {
      new cls(this, id, {
        zone,
        recordName: `app.${domain}`,
        target: route53.RecordTarget.fromAlias(
          new r53targets.CloudFrontTarget(distribution),
        ),
      });
    }

    // ---------- Migration task definitions ----------
    // One per database (TDD 7.1): the workflow runs each via
    // `aws ecs run-task` before forcing new service deployments.
    const migrateTaskDefs = {} as Record<string, ecs.FargateTaskDefinition>;
    for (const dbName of ["auth", "docbridge", "platform"] as const) {
      const migrateRole = new iam.Role(this, `MigrateRole-${dbName}`, {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      });
      dbSecrets[dbName].grantRead(migrateRole);
      secretsKey.grantDecrypt(migrateRole);
      const def = new ecs.FargateTaskDefinition(this, `Migrate-${dbName}`, {
        cpu: 256,
        memoryLimitMiB: 512,
        taskRole: migrateRole,
        executionRole,
      });
      def.addContainer(`migrate-${dbName}`, {
        containerName: `migrate-${dbName}`,
        // The same monorepo image as the api service runs prisma migrate.
        image: ecs.ContainerImage.fromEcrRepository(repos.api, props.imageTag),
        command: [
          "pnpm",
          "--filter",
          `@docbridge/db-${dbName}`,
          "run",
          "migrate:deploy",
        ],
        environment: {
          NODE_ENV: "production",
          DB_HOST: db.instanceEndpoint.hostname,
          DB_NAME: dbName,
        },
        secrets: {
          DB_USERNAME: ecs.Secret.fromSecretsManager(
            dbSecrets[dbName],
            "username",
          ),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(
            dbSecrets[dbName],
            "password",
          ),
        },
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: `migrate-${dbName}`,
          logGroup: new logs.LogGroup(this, `LogGroup-migrate-${dbName}`, {
            logGroupName: `/docbridge/${envName}/migrate-${dbName}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        }),
      });
      migrateTaskDefs[dbName] = def;
      new cdk.CfnOutput(this, `MigrateTaskDef-${dbName}`, {
        value: def.taskDefinitionArn,
      });
    }

    // ---------- Alarms ----------
    const alarmTopic = new sns.Topic(this, "Alarms", {
      topicName: `docbridge-${envName}-alarms`,
    });
    const alarmAction = new cw_actions.SnsAction(alarmTopic);
    const addAlarm = (id: string, alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(alarmAction);
      return alarm;
    };
    addAlarm(
      "Alb5xx",
      new cloudwatch.Alarm(this, "Alb5xx", {
        metric: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      "TasksQueueOld",
      new cloudwatch.Alarm(this, "TasksQueueOld", {
        metric: tasksQueue.metricApproximateAgeOfOldestMessage(),
        threshold: 600,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    for (const [n, q] of [
      ["Tasks", tasksDlq],
      ["UploadEvents", uploadEventsDlq],
    ] as const) {
      addAlarm(
        `${n}DlqDepth`,
        new cloudwatch.Alarm(this, `${n}DlqDepth`, {
          metric: q.metricApproximateNumberOfMessagesVisible(),
          threshold: 0,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
    }
    // Per-route p99 is not measurable on the ALB; target-group p99 on the
    // api target group is the proxy (approximation per TDD 7.5).
    addAlarm(
      "ApiP99",
      new cloudwatch.Alarm(this, "ApiP99", {
        metric: targetGroups.api.metrics.targetResponseTime({
          statistic: "p99",
        }),
        threshold: 0.5,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, "ServiceSecurityGroup", {
      value: servicesSg.securityGroupId,
    });
    new cdk.CfnOutput(this, "PrivateSubnetIds", {
      value: vpc.privateSubnets.map((s) => s.subnetId).join(","),
    });
  }
}
