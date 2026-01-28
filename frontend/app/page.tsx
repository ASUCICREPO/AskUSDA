import ChatBot from "./components/ChatBot";

export default function Home() {
  return (
    <div className="min-h-screen bg-white">
      {/* Plain background - the chatbot floats over this */}
      <ChatBot />
    </div>
  );
}
