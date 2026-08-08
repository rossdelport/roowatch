import type { Metadata } from "next";
import reservePage from "./reserve.html?raw";

export const metadata: Metadata = {
  title: "RooWatch - Claim your spot",
  description:
    "RooWatch is full right now. Claim your spot on the waitlist and we message you when a place opens up.",
};

export default function Reserve() {
  return <div dangerouslySetInnerHTML={{ __html: reservePage }} />;
}
