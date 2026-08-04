import admin from "firebase-admin";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (serviceAccountJson) {
  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (e) {
    console.warn("Firebase Admin init failed:", e.message);
  }
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled");
}

export { admin };
