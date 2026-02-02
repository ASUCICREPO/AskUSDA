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
  conversationId?: string;
  sessionId?: string;
  responseTimeMs?: number;
  question?: string; // The user's question that prompted this response
}

interface WebSocketMessage {
  type: "stream" | "response" | "typing" | "error" | "feedbackConfirmation" | "conversationId" | "message" | "escalationConfirmation";
  chunk?: string;
  isComplete?: boolean;
  message?: string;
  citations?: Citation[];
  blocked?: boolean;
  status?: boolean;
  feedback?: "positive" | "negative";
  conversationId?: string;
  sessionId?: string;
  responseTimeMs?: number;
  isTyping?: boolean;
  success?: boolean;
  escalationId?: string;
  question?: string; // The original question (echoed back from server)
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
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
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

  // Reset chat to initial state
  const resetChat = useCallback(() => {
    setMessages([
      {
        id: "1",
        text: "Welcome to AskUSDA! I'm here to help you find information about USDA programs and services. How can I assist you today?",
        sender: "bot",
        timestamp: new Date(),
      },
    ]);
    setSessionId("");
    setInputValue("");
    currentStreamingMessageRef.current = "";
    streamingMessageIdRef.current = null;
    setIsTyping(false);
  }, []);

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
      case "conversationId":
        // Store conversation ID for feedback tracking
        if (data.conversationId && streamingMessageIdRef.current) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === streamingMessageIdRef.current
                ? { ...msg, conversationId: data.conversationId }
                : msg
            )
          );
        }
        break;

      case "typing":
        setIsTyping(data.isTyping || false);
        break;

      case "message":
        // Complete message with all data
        const messageId = streamingMessageIdRef.current || Date.now().toString();
        setMessages((prev) => {
          const existingIndex = prev.findIndex(msg => msg.id === messageId);
          const newMessage: Message = {
            id: messageId,
            text: data.message || "",
            sender: "bot",
            timestamp: new Date(),
            citations: data.citations,
            conversationId: data.conversationId,
            sessionId: data.sessionId,
            responseTimeMs: data.responseTimeMs,
            question: data.question, // Store the question for feedback submission
            isStreaming: false,
          };
          
          if (existingIndex >= 0) {
            return prev.map((msg, idx) => idx === existingIndex ? newMessage : msg);
          } else {
            return [...prev, newMessage];
          }
        });
        
        if (data.sessionId) {
          setSessionId(data.sessionId);
        }
        
        currentStreamingMessageRef.current = "";
        streamingMessageIdRef.current = null;
        setIsTyping(false);
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

      case "feedbackConfirmation":
        console.log("Feedback confirmed:", data.feedback, "for", data.conversationId);
        break;

      case "escalationConfirmation":
        if (data.success) {
          setShowSupportModal(false);
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              text: data.message || "Your support request has been submitted. We will contact you soon.",
              sender: "bot",
              timestamp: new Date(),
            },
          ]);
        }
        break;
    }
  }, []);

  // Send feedback to backend (this also saves the conversation - only conversations with feedback are stored)
  const handleFeedback = useCallback((messageId: string, feedback: "positive" | "negative") => {
    const message = messages.find(msg => msg.id === messageId);
    if (!message?.conversationId) {
      console.warn("No conversation ID for feedback");
      return;
    }

    // Update local state immediately for responsive UI
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId ? { ...msg, feedback } : msg
      )
    );

    // Send to backend via WebSocket - include all data needed to save the conversation
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          action: "submitFeedback",
          feedback,
          conversationId: message.conversationId,
          question: message.question,
          answer: message.text,
          sessionId: message.sessionId || sessionId,
          responseTimeMs: message.responseTimeMs,
          citations: message.citations,
        })
      );
    }
  }, [messages, sessionId]);

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
          sessionId: sessionId || undefined,
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

  // Handle support form submission
  const handleSupportSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    const supportData = {
      name: formData.get("name") as string,
      email: formData.get("email") as string,
      phone: formData.get("phone") as string,
      question: formData.get("question") as string,
    };

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          action: "submitEscalation",
          ...supportData,
          sessionId: sessionId || undefined,
        })
      );
    }
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
            <button
              onClick={resetChat}
              className="flex items-center gap-3 rounded-lg transition-opacity hover:opacity-80"
              title="Start new conversation"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white p-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/usda-symbol.svg"
                  alt="USDA"
                  className="h-full w-full"
                />
              </div>
              <div className="text-left">
                <h3 className="font-semibold text-white">AskUSDA</h3>
                <p className="text-xs text-white/80">
                  {isConnecting
                    ? "Connecting..."
                    : isConnected
                      ? "Online"
                      : "Demo Mode"}
                </p>
              </div>
            </button>
            <div className="flex items-center gap-2">
              {/* Support/Email button */}
              <button
                onClick={() => setShowSupportModal(true)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                aria-label="Contact support"
                title="Contact support"
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
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-10 5L2 7" />
                </svg>
              </button>
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
                      <div className="mt-3 border-t border-gray-200 pt-3">
                        <p className="mb-2 text-sm font-semibold text-gray-700">
                          Sources:
                        </p>
                        <div className="space-y-2">
                          {message.citations.slice(0, 3).map((citation, index) => (
                            <a
                              key={citation.id}
                              href={citation.source}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block text-[#1a5fb4] hover:underline"
                            >
                              <span className="inline-block mr-1.5">↗</span>
                              <span className="text-sm font-medium">Source {index + 1}</span>
                            </a>
                          ))}
                        </div>

                        {/* Horizontal divider */}
                        <hr className="my-3 border-gray-200" />

                        {/* Confidence indicator */}
                        {(() => {
                          const maxScore = Math.max(...message.citations.map(c => c.score || 0));
                          const isHigh = maxScore >= 0.5;
                          return (
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-gray-700">Confidence:</span>
                              <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                                isHigh
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-red-100 text-red-700'
                              }`}>
                                {isHigh ? 'High Confidence' : 'Low Confidence'}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                    {/* Feedback Buttons - only for bot messages with conversationId, not welcome message, not while streaming */}
                    {message.sender === "bot" && message.id !== "1" && !message.isStreaming && message.conversationId && (
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

      {/* Support Modal */}
      {showSupportModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Contact Support</h3>
              <button
                onClick={() => setShowSupportModal(false)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                aria-label="Close"
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
            
            <p className="mb-4 text-sm text-gray-600">
              Need help? Fill out this form and our team will get back to you soon.
            </p>

            <form onSubmit={handleSupportSubmit} className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                  Name *
                </label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#002d72] focus:outline-none focus:ring-2 focus:ring-[#002d72]/20"
                  placeholder="Your name"
                />
              </div>

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                  Email *
                </label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#002d72] focus:outline-none focus:ring-2 focus:ring-[#002d72]/20"
                  placeholder="your.email@example.com"
                />
              </div>

              <div>
                <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
                  Phone (optional)
                </label>
                <input
                  type="tel"
                  id="phone"
                  name="phone"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#002d72] focus:outline-none focus:ring-2 focus:ring-[#002d72]/20"
                  placeholder="(555) 123-4567"
                />
              </div>

              <div>
                <label htmlFor="question" className="block text-sm font-medium text-gray-700 mb-1">
                  How can we help you? *
                </label>
                <textarea
                  id="question"
                  name="question"
                  required
                  rows={4}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#002d72] focus:outline-none focus:ring-2 focus:ring-[#002d72]/20"
                  placeholder="Please describe your question or issue..."
                />
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowSupportModal(false)}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-lg bg-[#002d72] px-4 py-2 text-sm font-medium text-white hover:bg-[#001f4d]"
                >
                  Submit Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
