import type { Metadata } from "next";
import DashboardApp from "./DashboardApp";

export const metadata: Metadata = {
  title: "RooWatch - Dashboard",
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return <DashboardApp />;
}
