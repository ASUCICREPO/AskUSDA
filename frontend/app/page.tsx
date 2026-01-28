import Image from "next/image";
import ChatBot from "./components/ChatBot";

export default function Home() {
  return (
    <div className="relative min-h-screen">
      {/* Background Image */}
      <Image
        src="/usda-bg.png"
        alt="USDA Website"
        fill
        className="object-cover object-top"
        priority
      />

      {/* Chatbot floats over the background */}
      <ChatBot />
    </div>
  );
}
