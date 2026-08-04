import { readFileSync } from "node:fs";
import { join } from "node:path";

const landingPage = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

export default function Home() {
  return <div dangerouslySetInnerHTML={{ __html: landingPage }} />;
}
