"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";

interface Citation {
  id: number;
  text: string;
  source: string;
  score: number;
}

interface Message {
  id: string;
  text: string;
  sender: "user" | "bot";
  timestamp: Date;
  citations?: Citation[];
  isStreaming?: boolean;
  feedback?: "positive" | "negative" | null;
}

interface WebSocketMessage {
  type: "stream" | "response" | "typing" | "error" | "feedbackReceived";
  chunk?: string;
  isComplete?: boolean;
  message?: string;
  citations?: Citation[];
  blocked?: boolean;
  status?: boolean;
  feedback?: "positive" | "negative";
}

const suggestedQuestions = [
  "How do I apply for farm loans?",
  "What USDA programs are available?",
  "How to report a food safety issue?",
  "Find local USDA service centers",
];

const WEBSOCKET_URL = process.env.NEXT_PUBLIC_WEBSOCKET_URL || "";

export default function ChatBot() {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      text: "Welcome to AskUSDA! I'm here to help you find information about USDA programs and services. How can I assist you today?",
      sender: "bot",
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentStreamingMessageRef = useRef<string>("");
  const streamingMessageIdRef = useRef<string | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Connect to WebSocket when chat opens
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || isConnecting) {
      return;
    }

    if (!WEBSOCKET_URL) {
      console.warn("WebSocket URL not configured. Running in demo mode.");
      setIsConnected(false);
      return;
    }

    setIsConnecting(true);
    console.log("Connecting to WebSocket:", WEBSOCKET_URL);

    const ws = new WebSocket(WEBSOCKET_URL);

    ws.onopen = () => {
      console.log("WebSocket connected");
      setIsConnected(true);
      setIsConnecting(false);
    };

    ws.onmessage = (event) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data);
        handleWebSocketMessage(data);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setIsConnected(false);
      setIsConnecting(false);
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected");
      setIsConnected(false);
      setIsConnecting(false);
      wsRef.current = null;
    };

    wsRef.current = ws;
  }, [isConnecting]);

  // Handle incoming WebSocket messages
  const handleWebSocketMessage = useCallback((data: WebSocketMessage) => {
    switch (data.type) {
      case "typing":
        setIsTyping(data.status || false);
        break;

      case "stream":
        if (data.chunk) {
          currentStreamingMessageRef.current += data.chunk;
          
          // Create or update streaming message
          if (!streamingMessageIdRef.current) {
            streamingMessageIdRef.current = Date.now().toString();
            setMessages((prev) => [
              ...prev,
              {
                id: streamingMessageIdRef.current!,
                text: currentStreamingMessageRef.current,
                sender: "bot",
                timestamp: new Date(),
                isStreaming: true,
              },
            ]);
          } else {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageIdRef.current
                  ? { ...msg, text: currentStreamingMessageRef.current }
                  : msg
              )
            );
          }
        }

        if (data.isComplete) {
          // Mark streaming as complete
          if (streamingMessageIdRef.current) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamingMessageIdRef.current
                  ? { ...msg, isStreaming: false }
                  : msg
              )
            );
          }
        }
        break;

      case "response":
        // Final response with citations - update the streaming message or add new one
        if (streamingMessageIdRef.current) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageIdRef.current
                ? {
                    ...msg,
                    text: data.message || msg.text,
                    citations: data.citations,
                    isStreaming: false,
                  }
                : msg
            )
          );
        } else if (data.message) {
          // Non-streaming response
          const messageText = data.message;
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              text: messageText,
              sender: "bot",
              timestamp: new Date(),
              citations: data.citations,
            },
          ]);
        }
        // Reset streaming refs
        currentStreamingMessageRef.current = "";
        streamingMessageIdRef.current = null;
        setIsTyping(false);
        break;

      case "error":
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            text: data.message || "An error occurred. Please try again.",
            sender: "bot",
            timestamp: new Date(),
          },
        ]);
        currentStreamingMessageRef.current = "";
        streamingMessageIdRef.current = null;
        setIsTyping(false);
        break;

      case "feedbackReceived":
        console.log("Feedback received:", data.feedback);
        break;
    }
  }, []);

  // Send feedback to backend
  const handleFeedback = useCallback((messageId: string, feedback: "positive" | "negative") => {
    // Update local state immediately for responsive UI
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId ? { ...msg, feedback } : msg
      )
    );

    // Send to backend via WebSocket
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          action: "submitFeedback",
          feedback,
          messageId,
        })
      );
    }
  }, []);

  // Connect when chat opens
  useEffect(() => {
    if (isOpen && !wsRef.current) {
      connectWebSocket();
    }
  }, [isOpen, connectWebSocket]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const handleSendMessage = async (text: string) => {
    if (!text.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: text.trim(),
      sender: "user",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");

    // Send via WebSocket if connected
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setIsTyping(true);
      wsRef.current.send(
        JSON.stringify({
          action: "sendMessage",
          message: text.trim(),
          useStreaming: true,
        })
      );
    } else {
      // Demo mode - simulate response
      setIsTyping(true);
      setTimeout(() => {
        const botMessage: Message = {
          id: (Date.now() + 1).toString(),
          text: "I'm currently running in demo mode. To connect to the USDA knowledge base, please ensure the backend WebSocket server is deployed and configured.",
          sender: "bot",
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, botMessage]);
        setIsTyping(false);
      }, 1500);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(inputValue);
    }
  };

  const handleSuggestedQuestion = (question: string) => {
    handleSendMessage(question);
  };

  return (
    <>
      {/* Chat Button */}
      <div
        className="fixed bottom-6 right-6 z-50"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {!isOpen && (
          <button
            onClick={() => setIsOpen(true)}
            className={`
              flex items-center gap-2 rounded-full bg-[#1a4a8a] px-5 py-3
              text-white shadow-lg transition-all duration-300 hover:bg-[#002d72]
              hover:shadow-xl
              ${isHovered ? "scale-105" : "scale-100"}
            `}
            aria-label="Open AskUSDA chat"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span className="font-semibold">AskUSDA</span>
          </button>
        )}
      </div>

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 z-50 flex h-[520px] w-[380px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between bg-[#002d72] px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white p-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/usda-symbol.svg"
                  alt="USDA"
                  className="h-full w-full"
                />
              </div>
              <div>
                <h3 className="font-semibold text-white">AskUSDA</h3>
                <p className="text-xs text-white/80">
                  {isConnecting
                    ? "Connecting..."
                    : isConnected
                      ? "Online"
                      : "Demo Mode"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Connection status indicator */}
              <div
                className={`h-2 w-2 rounded-full ${
                  isConnected
                    ? "bg-green-400"
                    : isConnecting
                      ? "animate-pulse bg-yellow-400"
                      : "bg-gray-400"
                }`}
              />
              <button
                onClick={() => setIsOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                aria-label="Close chat"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto bg-gray-50 p-4">
            <div className="space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.sender === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] overflow-hidden rounded-2xl px-4 py-3 ${
                      message.sender === "user"
                        ? "bg-[#002d72] text-white"
                        : "bg-white text-gray-800 shadow-sm"
                    }`}
                  >
                    <div
                      className={`prose prose-sm max-w-none overflow-wrap-anywhere ${
                        message.sender === "user"
                          ? "prose-invert prose-p:text-white prose-a:text-blue-200"
                          : "prose-gray prose-a:text-[#002d72]"
                      }`}
                    >
                      <ReactMarkdown
                        components={{
                          // Style links to be clickable and visible
                          a: ({ href, children }) => (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`underline hover:opacity-80 ${
                                message.sender === "user"
                                  ? "text-blue-200"
                                  : "text-[#002d72]"
                              }`}
                            >
                              {children}
                            </a>
                          ),
                          // Style paragraphs
                          p: ({ children }) => (
                            <p className="mb-2 last:mb-0 text-sm leading-relaxed">
                              {children}
                            </p>
                          ),
                          // Style unordered lists with proper bullets
                          ul: ({ children }) => (
                            <ul className="mb-2 ml-4 list-disc space-y-1 text-sm">
                              {children}
                            </ul>
                          ),
                          // Style ordered lists
                          ol: ({ children }) => (
                            <ol className="mb-2 ml-4 list-decimal space-y-1 text-sm">
                              {children}
                            </ol>
                          ),
                          // Style list items
                          li: ({ children }) => (
                            <li className="leading-relaxed">{children}</li>
                          ),
                          // Style bold text
                          strong: ({ children }) => (
                            <strong className="font-semibold">{children}</strong>
                          ),
                          // Style headings
                          h1: ({ children }) => (
                            <h1 className="mb-2 text-base font-bold">{children}</h1>
                          ),
                          h2: ({ children }) => (
                            <h2 className="mb-2 text-sm font-bold">{children}</h2>
                          ),
                          h3: ({ children }) => (
                            <h3 className="mb-1 text-sm font-semibold">{children}</h3>
                          ),
                          // Style code blocks
                          code: ({ children }) => (
                            <code className="rounded bg-gray-100 px-1 py-0.5 text-xs text-gray-800">
                              {children}
                            </code>
                          ),
                        }}
                      >
                        {message.text}
                      </ReactMarkdown>
                      {message.isStreaming && (
                        <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-gray-400" />
                      )}
                    </div>
                    {/* Citations */}
                    {message.citations && message.citations.length > 0 && (
                      <div className="mt-3 border-t border-gray-200 pt-2">
                        <p className="mb-1 text-xs font-medium text-gray-500">
                          Sources:
                        </p>
                        <div className="space-y-1">
                          {message.citations.slice(0, 3).map((citation) => (
                            <a
                              key={citation.id}
                              href={citation.source}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate text-xs text-[#002d72] hover:underline"
                            >
                              {citation.source}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Feedback Buttons - only for bot messages, not welcome message, not while streaming */}
                    {message.sender === "bot" && message.id !== "1" && !message.isStreaming && (
                      <div className="mt-3 border-t border-gray-200 pt-2">
                        {message.feedback ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">
                              Thanks for your feedback!
                            </span>
                            {message.feedback === "positive" ? (
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="#22c55e"
                                stroke="#22c55e"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                              </svg>
                            ) : (
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="#ef4444"
                                stroke="#ef4444"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
                              </svg>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="mr-2 text-xs text-gray-400">Was this helpful?</span>
                            <button
                              onClick={() => handleFeedback(message.id, "positive")}
                              className="rounded-lg p-1.5 text-gray-400 transition-all hover:bg-green-50 hover:text-green-600 active:scale-95"
                              aria-label="Thumbs up"
                              title="Yes, this was helpful"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleFeedback(message.id, "negative")}
                              className="rounded-lg p-1.5 text-gray-400 transition-all hover:bg-red-50 hover:text-red-600 active:scale-95"
                              aria-label="Thumbs down"
                              title="No, this wasn't helpful"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
                              </svg>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {isTyping && !streamingMessageIdRef.current && (
                <div className="flex justify-start">
                  <div className="rounded-2xl bg-white px-4 py-3 shadow-sm">
                    <div className="flex gap-1">
                      <span
                        className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                        style={{ animationDelay: "0ms" }}
                      />
                      <span
                        className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                        style={{ animationDelay: "150ms" }}
                      />
                      <span
                        className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                        style={{ animationDelay: "300ms" }}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Suggested Questions - only show when there's just the welcome message */}
            {messages.length === 1 && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium text-gray-500">
                  Suggested questions:
                </p>
                <div className="flex flex-wrap gap-2">
                  {suggestedQuestions.map((question, index) => (
                    <button
                      key={index}
                      onClick={() => handleSuggestedQuestion(question)}
                      className="rounded-full border border-[#002d72]/30 bg-white px-3 py-1.5 text-xs text-[#002d72] transition-colors hover:bg-[#002d72] hover:text-white"
                    >
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Input Area */}
          <div className="border-t border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your question..."
                disabled={isTyping}
                className="flex-1 rounded-full border border-gray-300 px-4 py-2.5 text-sm text-gray-800 placeholder-gray-400 outline-none transition-colors focus:border-[#002d72] focus:ring-2 focus:ring-[#002d72]/20 disabled:bg-gray-50 disabled:cursor-not-allowed"
              />
              <button
                onClick={() => handleSendMessage(inputValue)}
                disabled={!inputValue.trim() || isTyping}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-[#002d72] text-white transition-colors hover:bg-[#001f4d] disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Send message"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
