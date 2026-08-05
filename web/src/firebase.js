import { readFileSync, existsSync } from "fs";
import admin from "firebase-admin";

const accountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const accountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

let serviceAccount;
if (accountPath && existsSync(accountPath)) {
  try {
    serviceAccount = JSON.parse(readFileSync(accountPath, "utf8"));
  } catch (e) {
    console.warn("Firebase: failed to read service account file:", e.message);
  }
} else if (accountJson) {
  try {
    serviceAccount = JSON.parse(accountJson);
  } catch (e) {
    console.warn("Firebase: failed to parse FIREBASE_SERVICE_ACCOUNT:", e.message);
  }
}

if (serviceAccount) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} else {
  console.warn("Firebase service account not configured — push notifications disabled");
}

export { admin };
