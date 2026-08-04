"use client";

import { useEffect } from "react";
import landingPage from "./landing.html?raw";

export default function Home() {
  useEffect(() => {
    const card = document.querySelector(".intent-card");
    if (!card) return;
    card.classList.add("scan-wait");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          card.classList.remove("scan-wait");
          card.classList.add("scan-go");
          io.disconnect();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(card);
    return () => io.disconnect();
  }, []);

  return <div dangerouslySetInnerHTML={{ __html: landingPage }} />;
}
