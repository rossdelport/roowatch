import { redirect } from "next/navigation";

/** People type /login out of habit. Send them to the one auth page. */
export default function LoginPage() {
  redirect("/signup?mode=login");
}
