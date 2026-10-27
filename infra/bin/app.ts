import * as cdk from "aws-cdk-lib";
import {
  DocBridgeStack,
  CertStack,
  EnvironmentConfig,
} from "../lib/docbridge-stack";

const app = new cdk.App();
// The `environments` context in cdk.json holds PLACEHOLDER values
// (domain, hosted zone id, account) filled in when real accounts exist.
const environments = app.node.tryGetContext("environments") as Record<
  string,
  EnvironmentConfig
>;
const imageTag = (app.node.tryGetContext("imageTag") as string) ?? "latest";

for (const [envName, env] of Object.entries(environments)) {
  const props = { env: { account: env.account, region: env.region } };
  // CloudFront certificates must live in us-east-1: a separate stack
  // whose ARN is passed to the main stack via a cross-region reference.
  const cert = new CertStack(app, `DocBridgeCert-${envName}`, {
    env: { account: env.account, region: "us-east-1" },
    crossRegionReferences: true,
    envName,
    domainName: env.domainName,
  });
  new DocBridgeStack(app, `DocBridge-${envName}`, {
    ...props,
    crossRegionReferences: true,
    envName,
    config: env,
    imageTag,
    webCertificateArn: cert.certificate.certificateArn,
  });
}
