import { readFileSync, statSync } from "fs";
import { cert, initializeApp } from "firebase-admin";
import { getMessaging } from "firebase-admin/messaging";

const accountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const accountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

let serviceAccount;
if (accountPath && (() => { try { return statSync(accountPath).isFile(); } catch { return false; } })()) {
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
  initializeApp({ credential: cert(serviceAccount) });
} else {
  console.warn("Firebase service account not configured — push notifications disabled");
}

export const messaging = serviceAccount ? getMessaging() : null;
