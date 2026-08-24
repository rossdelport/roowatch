import type { Metadata } from "next";
import reservePage from "./reserve.html?raw";

export const metadata: Metadata = {
  title: "RooWatch - Start getting leads",
  description:
    "RooWatch watches your local Facebook groups and texts you the moment somebody needs your trade. Free for 14 days.",
};

export default function Reserve() {
  return <div dangerouslySetInnerHTML={{ __html: reservePage }} />;
}
