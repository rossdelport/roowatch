import type { Metadata } from "next";
import SignupApp from "./SignupApp";

export const metadata: Metadata = {
  title: "RooWatch - Sign up or log in",
  description:
    "Create your RooWatch account and we start watching your local Facebook groups for jobs today.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  return <SignupApp start={mode === "login" ? "login" : "signup"} />;
}
