import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';

let app = null;
let db = null;
let auth = null;

export function initFirebase(config, dbName) {
  app = initializeApp(config);
  db = dbName ? getFirestore(app, dbName) : getFirestore(app);
  auth = getAuth(app);
  return app;
}

export async function signIn() {
  await signInAnonymously(auth);
  console.log('[SecBits] Signed in anonymously');
}

export async function fetchUserName(userId) {
  const docId = String(userId);
  console.log('[SecBits] Fetching user: collection=users, doc=' + docId);
  const docRef = doc(db, 'users', docId);
  const snap = await getDoc(docRef);
  console.log('[SecBits] Doc exists:', snap.exists(), snap.exists() ? snap.data() : '');
  if (snap.exists()) {
    return snap.data().username || '';
  }
  return '';
}
