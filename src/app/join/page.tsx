import { connection } from "next/server";
import JoinClient from "./JoinClient";

export default async function JoinPage() {
  // Nonce-based CSP must be generated per request, so this page cannot be prerendered.
  await connection();
  return <JoinClient />;
}
