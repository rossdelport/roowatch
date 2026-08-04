import type { Metadata } from "next";
import onTheListPage from "./on-the-list.html?raw";

export const metadata: Metadata = {
  title: "RooWatch - You're on the list",
  description:
    "Your RooWatch spot is reserved. We will message you when a place opens up.",
};

export default function OnTheList() {
  return <div dangerouslySetInnerHTML={{ __html: onTheListPage }} />;
}
