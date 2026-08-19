import type { Metadata } from "next";
import { DEFAULT_PLAN, PLAN_KEYS, type PlanKey } from "../../db/plans";
import SignupApp from "./SignupApp";

export const metadata: Metadata = {
  title: "RooWatch - Sign up or log in",
  description:
    "Create your RooWatch account and we start watching your local Facebook groups for jobs today.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; plan?: string }>;
}) {
  const { mode, plan } = await searchParams;
  const chosenPlan = PLAN_KEYS.includes(plan as PlanKey) ? (plan as PlanKey) : DEFAULT_PLAN;
  return <SignupApp start={mode === "login" ? "login" : "signup"} plan={chosenPlan} />;
}
