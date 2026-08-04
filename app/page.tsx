import landingPage from "./landing.html?raw";

export default function Home() {
  return <div dangerouslySetInnerHTML={{ __html: landingPage }} />;
}
