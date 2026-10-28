import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ format: "pem", type: "pkcs8" });
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const kid = `k-${stamp}-${randomBytes(3).toString("hex")}`;
const json = JSON.stringify({ kid, privateKey: pem });
console.log(`JWT_SIGNING_KEY='${json}'`);
