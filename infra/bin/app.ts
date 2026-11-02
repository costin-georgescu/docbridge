import * as cdk from "aws-cdk-lib";
import { DocBridgeStack, CertStack, ReposStack } from "../lib/docbridge-stack";
import { resolveEnvironments } from "../lib/environments";

const app = new cdk.App();
// cdk.json `environments` holds PLACEHOLDER values for offline synth;
// DOCBRIDGE_ENVIRONMENTS (JSON) replaces them on real deploys, and
// `-c environment=<name>` limits work to one environment.
const environments = resolveEnvironments({
  context: app.node.tryGetContext("environments"),
  env: process.env,
  selected: app.node.tryGetContext("environment"),
});
const imageTag = (app.node.tryGetContext("imageTag") as string) ?? "latest";
// -c firstDeploy=true: services come up at desiredCount 0 so the DB
// bootstrap/migrations/JWT key can run first; redeploy without the flag
// afterwards to reach the normal counts.
const firstDeploy = app.node.tryGetContext("firstDeploy") === "true";

for (const [envName, env] of Object.entries(environments)) {
  const props = { env: { account: env.account, region: env.region } };
  const repos = new ReposStack(app, `DocBridgeRepos-${envName}`, props);
  // CloudFront certificates must live in us-east-1: a separate stack
  // whose ARN is passed to the main stack via a cross-region reference.
  const cert = new CertStack(app, `DocBridgeCert-${envName}`, {
    env: { account: env.account, region: "us-east-1" },
    crossRegionReferences: true,
    envName,
    domainName: env.domainName,
    hostedZoneId: env.hostedZoneId,
  });
  new DocBridgeStack(app, `DocBridge-${envName}`, {
    ...props,
    crossRegionReferences: true,
    envName,
    config: env,
    imageTag,
    webCertificateArn: cert.certificate.certificateArn,
    repos: repos.repos,
    servicesEnabled: !firstDeploy,
  });
}
