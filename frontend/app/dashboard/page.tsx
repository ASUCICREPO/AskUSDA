"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { useAdminAuth } from "../context/AdminAuthContext";

interface EscalationRequest {
  id: string;
  name: string;
  email: string;
  phone: string;
  question: string;
  requestDate: string;
}

interface ConversationMessage {
  role: "user" | "bot";
  content: string;
  timestamp: string;
}

interface FeedbackConversation {
  id: string;
  sessionId: string;
  question: string;
  feedback: "positive" | "negative" | "neutral";
  module: string;
  timestamp: string;
  conversation: ConversationMessage[];
}

interface Metrics {
  totalConversations: number;
  totalMessages: number;
  escalations: number;
  feedback: {
    positive: number;
    negative: number;
    neutral: number;
    total: number;
  };
}

const ADMIN_API_URL = process.env.NEXT_PUBLIC_ADMIN_API_URL || "";

// Icons for stats
const statsIcons = {
  conversations: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  upvotes: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  ),
  downvotes: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </svg>
  ),
  escalations: (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

const feedbackColors = {
  positive: "bg-green-100 text-green-800",
  negative: "bg-red-100 text-red-800",
  neutral: "bg-gray-100 text-gray-800",
};

const feedbackIcons = {
  positive: (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  ),
  negative: (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </svg>
  ),
  neutral: (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ),
};

export default function AdminPage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading, signOut } = useAdminAuth();
  
  const [feedbackFilter, setFeedbackFilter] = useState<string>("all");
  const [selectedConversation, setSelectedConversation] = useState<FeedbackConversation | null>(null);
  const [selectedEscalation, setSelectedEscalation] = useState<EscalationRequest | null>(null);
  
  // Data states
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [escalationRequests, setEscalationRequests] = useState<EscalationRequest[]>([]);
  const [feedbackConversations, setFeedbackConversations] = useState<FeedbackConversation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/admin');
    }
  }, [isAuthenticated, authLoading, router]);

  // Fetch data from API
  const fetchData = useCallback(async () => {
    if (!ADMIN_API_URL) {
      setError("Admin API URL not configured");
      setIsLoading(false);
      return;
    }

    if (!user?.idToken) {
      setError("Not authenticated");
      setIsLoading(false);
      return;
    }

    const headers = {
      'Authorization': user.idToken,
      'Content-Type': 'application/json',
    };

    try {
      setIsLoading(true);
      setError(null);

      // Fetch all data in parallel
      const [metricsRes, feedbackRes, escalationsRes] = await Promise.all([
        fetch(`${ADMIN_API_URL}/metrics`, { headers }),
        fetch(`${ADMIN_API_URL}/feedback`, { headers }),
        fetch(`${ADMIN_API_URL}/escalations`, { headers }),
      ]);

      // Check for authentication errors
      if (metricsRes.status === 401 || feedbackRes.status === 401 || escalationsRes.status === 401) {
        signOut();
        router.push('/admin');
        return;
      }

      if (!metricsRes.ok || !feedbackRes.ok || !escalationsRes.ok) {
        throw new Error("Failed to fetch data from API");
      }

      const [metricsData, feedbackData, escalationsData] = await Promise.all([
        metricsRes.json(),
        feedbackRes.json(),
        escalationsRes.json(),
      ]);

      setMetrics(metricsData);
      setFeedbackConversations(feedbackData);
      setEscalationRequests(escalationsData);
    } catch (err) {
      console.error("Error fetching admin data:", err);
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setIsLoading(false);
    }
  }, [user?.idToken, signOut, router]);

  // Fetch data on mount (only when authenticated)
  useEffect(() => {
    if (isAuthenticated && user?.idToken) {
      fetchData();
    }
  }, [isAuthenticated, user?.idToken, fetchData]);

  // Delete escalation
  const handleDeleteEscalation = async (id: string) => {
    if (!ADMIN_API_URL || !user?.idToken) return;
    
    try {
      const res = await fetch(`${ADMIN_API_URL}/escalations/${id}`, {
        method: "DELETE",
        headers: {
          'Authorization': user.idToken,
          'Content-Type': 'application/json',
        },
      });

      if (res.ok) {
        setEscalationRequests((prev) => prev.filter((e) => e.id !== id));
      }
    } catch (err) {
      console.error("Error deleting escalation:", err);
    }
  };

  const filteredRequests = escalationRequests;

  const filteredFeedback = feedbackConversations.filter((conv) => {
    const matchesFeedback = feedbackFilter === "all" || conv.feedback === feedbackFilter;
    return matchesFeedback;
  });

  // Build stats from metrics
  const stats = [
    {
      label: "Total Conversations",
      value: metrics?.totalConversations?.toString() || "0",
      change: "--",
      changeType: "positive" as const,
      icon: statsIcons.conversations,
    },
    {
      label: "Total Upvotes",
      value: metrics?.feedback?.positive?.toString() || "0",
      change: "--",
      changeType: "positive" as const,
      icon: statsIcons.upvotes,
    },
    {
      label: "Total Downvotes",
      value: metrics?.feedback?.negative?.toString() || "0",
      change: "--",
      changeType: "positive" as const,
      icon: statsIcons.downvotes,
    },
    {
      label: "Escalations",
      value: metrics?.escalations?.toString() || "0",
      change: "--",
      changeType: "positive" as const,
      icon: statsIcons.escalations,
    },
  ];

  // Show loading while checking auth
  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#002d72] border-t-transparent" />
          <span className="text-gray-600">Loading...</span>
        </div>
      </div>
    );
  }

  // Don't render if not authenticated (will redirect)
  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white p-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/usda-symbol.svg"
                alt="USDA"
                className="h-full w-full"
              />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">AskUSDA</h1>
              <p className="text-sm text-gray-500">Admin Dashboard</p>
            </div>
          </div>
          <button
            onClick={fetchData}
            disabled={isLoading}
            className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
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
              className={isLoading ? "animate-spin" : ""}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
            Refresh
          </button>
          <button
            onClick={() => {
              signOut();
              router.push('/admin');
            }}
            className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
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
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign Out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* Loading State */}
        {isLoading && (
          <div className="mb-8 flex items-center justify-center py-12">
            <div className="flex items-center gap-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#002d72] border-t-transparent" />
              <span className="text-gray-600">Loading dashboard data...</span>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !isLoading && (
          <div className="mb-8 rounded-xl border border-red-200 bg-red-50 p-4">
            <div className="flex items-center gap-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-600">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div>
                <p className="font-medium text-red-800">Error loading data</p>
                <p className="text-sm text-red-600">{error}</p>
              </div>
              <button
                onClick={fetchData}
                className="ml-auto rounded-lg bg-red-100 px-3 py-1.5 text-sm font-medium text-red-800 transition-colors hover:bg-red-200"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Stats Cards */}
        <div className="mb-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((stat, index) => (
            <div
              key={index}
              className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#002d72]/10 text-[#002d72]">
                  {stat.icon}
                </div>
                <span
                  className={`text-sm font-medium ${
                    stat.changeType === "positive" ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {stat.change}
                </span>
              </div>
              <div className="mt-4">
                <p className="text-3xl font-bold text-gray-900">{stat.value}</p>
                <p className="mt-1 text-sm text-gray-500">{stat.label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Escalation Requests Table */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Escalation Requests</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Phone
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Question
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredRequests.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center">
                      <p className="text-sm text-gray-500">No escalation requests yet</p>
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map((request) => (
                    <tr key={request.id} className="transition-colors hover:bg-gray-50">
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#002d72] text-sm font-medium text-white">
                            {request.name
                              .split(" ")
                              .map((n) => n[0])
                              .join("")}
                          </div>
                          <span className="font-medium text-gray-900">{request.name}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                        {request.email}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                        {request.phone}
                      </td>
                      <td className="max-w-xs truncate px-6 py-4 text-sm text-gray-600">
                        {request.question}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                        {new Date(request.requestDate).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setSelectedEscalation(request)}
                            className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-[#002d72]"
                            title="View question"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDeleteEscalation(request.id)}
                            className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600"
                            title="Delete"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination - only show when there are items */}
          {filteredRequests.length > 0 && (
            <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4">
              <p className="text-sm text-gray-500">
                Showing <span className="font-medium">{filteredRequests.length}</span> of{" "}
                <span className="font-medium">{escalationRequests.length}</span> results
              </p>
              {escalationRequests.length > 10 && (
                <div className="flex items-center gap-2">
                  <button className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
                    Previous
                  </button>
                  <button className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Conversation Feedback Table */}
        <div className="mt-8 rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
            <h2 className="text-lg font-semibold text-gray-900">Conversation Feedback</h2>
            <div className="flex items-center gap-3">
              <select
                value={feedbackFilter}
                onChange={(e) => setFeedbackFilter(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 outline-none focus:border-[#002d72] focus:ring-2 focus:ring-[#002d72]/20"
              >
                <option value="all">All Feedback</option>
                <option value="positive">Positive</option>
                <option value="negative">Negative</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Session ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Feedback
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredFeedback.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center">
                      <p className="text-sm text-gray-500">No feedback received yet</p>
                    </td>
                  </tr>
                ) : (
                  filteredFeedback.map((conv) => (
                    <tr key={conv.id} className="transition-colors hover:bg-gray-50">
                      <td className="whitespace-nowrap px-6 py-4">
                        <span className="font-mono text-sm text-gray-600">{conv.sessionId.substring(0, 12)}...</span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-600">
                        {new Date(conv.timestamp).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${feedbackColors[conv.feedback]}`}
                        >
                          {feedbackIcons[conv.feedback]}
                          {conv.feedback.charAt(0).toUpperCase() + conv.feedback.slice(1)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <button
                          onClick={() => setSelectedConversation(conv)}
                          className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-[#002d72]"
                          title="View conversation"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination - only show when there are items */}
          {filteredFeedback.length > 0 && (
            <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4">
              <p className="text-sm text-gray-500">
                Showing <span className="font-medium">{filteredFeedback.length}</span> of{" "}
                <span className="font-medium">{feedbackConversations.length}</span> conversations
              </p>
              {feedbackConversations.length > 10 && (
                <div className="flex items-center gap-2">
                  <button className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
                    Previous
                  </button>
                  <button className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">
                    Next
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Conversation Viewer Modal */}
      {selectedConversation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[80vh] w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-gray-200 bg-[#002d72] px-6 py-4">
              <div>
                <h3 className="font-semibold text-white">Conversation Details</h3>
                <p className="text-sm text-white/80">
                  {selectedConversation.sessionId.substring(0, 12)}... • {selectedConversation.module}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${feedbackColors[selectedConversation.feedback]}`}
                >
                  {feedbackIcons[selectedConversation.feedback]}
                  {selectedConversation.feedback.charAt(0).toUpperCase() + selectedConversation.feedback.slice(1)}
                </span>
                <button
                  onClick={() => setSelectedConversation(null)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Modal Body - Conversation */}
            <div className="max-h-[60vh] overflow-y-auto bg-gray-50 p-4">
              <div className="space-y-4">
                {selectedConversation.conversation && selectedConversation.conversation.length > 0 ? (
                  selectedConversation.conversation.map((msg, index) => (
                    <div
                      key={index}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] overflow-hidden rounded-2xl px-4 py-3 ${
                          msg.role === "user"
                            ? "bg-[#002d72] text-white"
                            : "bg-white text-gray-800 shadow-sm"
                        }`}
                      >
                        <div
                          className={`prose prose-sm max-w-none overflow-wrap-anywhere ${
                            msg.role === "user"
                              ? "prose-invert prose-p:text-white prose-a:text-blue-200"
                              : "prose-gray prose-a:text-[#002d72]"
                          }`}
                        >
                          <ReactMarkdown
                            components={{
                              a: ({ href, children }) => (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`underline hover:opacity-80 ${
                                    msg.role === "user"
                                      ? "text-blue-200"
                                      : "text-[#002d72]"
                                  }`}
                                >
                                  {children}
                                </a>
                              ),
                              p: ({ children }) => (
                                <p className="mb-2 last:mb-0 text-sm leading-relaxed">
                                  {children}
                                </p>
                              ),
                              ul: ({ children }) => (
                                <ul className="mb-2 ml-4 list-disc space-y-1 text-sm">
                                  {children}
                                </ul>
                              ),
                              ol: ({ children }) => (
                                <ol className="mb-2 ml-4 list-decimal space-y-1 text-sm">
                                  {children}
                                </ol>
                              ),
                              li: ({ children }) => (
                                <li className="leading-relaxed">{children}</li>
                              ),
                              strong: ({ children }) => (
                                <strong className="font-semibold">{children}</strong>
                              ),
                              h1: ({ children }) => (
                                <h1 className="mb-2 text-base font-bold">{children}</h1>
                              ),
                              h2: ({ children }) => (
                                <h2 className="mb-2 text-sm font-bold">{children}</h2>
                              ),
                              h3: ({ children }) => (
                                <h3 className="mb-1 text-sm font-semibold">{children}</h3>
                              ),
                              code: ({ children }) => (
                                <code className="rounded bg-gray-100 px-1 py-0.5 text-xs text-gray-800">
                                  {children}
                                </code>
                              ),
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                        <p
                          className={`mt-2 text-xs ${
                            msg.role === "user" ? "text-white/60" : "text-gray-400"
                          }`}
                        >
                          {new Date(msg.timestamp).toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-3 text-gray-300">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <p className="text-sm text-gray-500">Conversation details not available</p>
                    <p className="mt-1 text-xs text-gray-400">The original messages may have expired</p>
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="border-t border-gray-200 bg-white px-6 py-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  {selectedConversation.conversation?.length || 0} messages in conversation
                </p>
                <button
                  onClick={() => setSelectedConversation(null)}
                  className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Escalation Request Viewer Modal */}
      {selectedEscalation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-gray-200 bg-[#002d72] px-6 py-4">
              <div>
                <h3 className="font-semibold text-white">Escalation Request</h3>
                <p className="text-sm text-white/80">
                  {new Date(selectedEscalation.requestDate).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
              </div>
              <button
                onClick={() => setSelectedEscalation(null)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6">
              {/* Contact Info */}
              <div className="mb-6 flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#002d72] text-lg font-medium text-white">
                  {selectedEscalation.name
                    .split(" ")
                    .map((n) => n[0])
                    .join("")}
                </div>
                <div>
                  <p className="font-semibold text-gray-900">{selectedEscalation.name}</p>
                  <p className="text-sm text-gray-500">{selectedEscalation.email}</p>
                  <p className="text-sm text-gray-500">{selectedEscalation.phone}</p>
                </div>
              </div>

              {/* Question */}
              <div className="rounded-xl bg-gray-50 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Question
                </p>
                <p className="text-sm leading-relaxed text-gray-800">
                  {selectedEscalation.question}
                </p>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="border-t border-gray-200 bg-gray-50 px-6 py-4">
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setSelectedEscalation(null)}
                  className="rounded-lg bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-300"
                >
                  Close
                </button>
                <a
                  href={`mailto:${selectedEscalation.email}`}
                  className="rounded-lg bg-[#002d72] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#001f4d]"
                >
                  Reply via Email
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
