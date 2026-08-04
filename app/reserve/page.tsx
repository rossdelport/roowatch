import type { Metadata } from "next";
import reservePage from "./reserve.html?raw";

export const metadata: Metadata = {
  title: "RooWatch - Reserve your spot",
  description:
    "RooWatch is full right now. Reserve your spot for $1 and we will message you when a place opens up.",
};

export default function Reserve() {
  return <div dangerouslySetInnerHTML={{ __html: reservePage }} />;
}
