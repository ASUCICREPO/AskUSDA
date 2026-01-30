# User Guide

This guide explains how to use the AskUSDA Chatbot.

---

## Prerequisites

**The application must be deployed before you use it.**

See the [Deployment Guide](./deploymentGuide.md) for deployment instructions.

---

## Introduction

AskUSDA is an AI-powered chatbot that helps the public, farmers, and ranchers find information about USDA programs and services. It uses official content from **usda.gov** and **farmers.gov** and cites sources so you can verify answers.

### Key Features

- **Hover chatbot**: Open the chat from the main page without leaving the USDA site experience.
- **USDA-focused answers**: Questions are answered from indexed USDA and farmers.gov content.
- **Source citations**: Responses include links to the source pages for verification.
- **Thumbs up/down feedback**: Rate answers to help improve the system.
- **Contact support**: Submit a support request (name, email, question) when you need follow-up from staff.

---

## Getting Started

### Step 1: Access the Application

Open the application URL you received after deployment (for example, the Amplify URL).

**Example**: `https://master.xxxxxxxxxx.amplifyapp.com`

You’ll see:

- A USDA-themed background (e.g. usda-bg.png).
- A **chat widget** (e.g. floating button or panel). Hover or click to open the chatbot.

---

### Step 2: Open the Chatbot

1. **Hover** over the chatbot widget, or **click** it, to open the chat panel.
2. You’ll see:
   - A welcome message (e.g. “Welcome to AskUSDA!…”).
   - **Suggested questions** you can click to start.
   - An input field at the bottom to type your own question.

---

### Step 3: Start a Conversation

**Option A: Use suggested questions**

Click one of the suggested questions, for example:

- “How do I apply for farm loans?”
- “What USDA programs are available?”
- “How to report a food safety issue?”
- “Find local USDA service centers”

**Option B: Type your own question**

Type in the input field and press **Enter** or click **Send**.

**Example questions:**

- “What USDA programs are available for new farmers?”
- “How do I apply for a farm loan?”
- “Where is my nearest USDA service center?”
- “How do I report a food safety concern?”

---

### Step 4: View the Response

When the bot replies:

1. A **typing indicator** (e.g. animated dots) shows while it’s thinking.
2. The **full answer** appears in the chat (formatted with markdown: lists, links, etc.).
3. **Citations** (source links) are shown below the answer when available.

---

### Step 5: Use Citations and Sources

After many answers, you’ll see a **Sources** or **Citations** section with links to usda.gov and farmers.gov pages.

- **Web links**: Click a citation to open the source page in a new tab.
- Use these links to confirm details (program names, deadlines, contact info, etc.).

---

### Step 6: Give Feedback

You can rate each bot response:

1. Find the **👍** (thumbs up) and **👎** (thumbs down) buttons below the response.
2. Click **thumbs up** if the answer was helpful.
3. Click **thumbs down** if it was unhelpful or wrong.

Your feedback is used to improve the chatbot.

---

### Step 7: Contact Support (Optional)

For questions the chatbot can’t answer or when you need human follow-up:

1. Click the **✉️ mail / contact** icon (e.g. in the chat header or footer).
2. The **“Contact Support”** modal opens.
3. Fill in:
   - **Name**
   - **Email**
   - **Phone** (optional)
   - **Your question**
4. Click **Submit**.

Your request is sent as an escalation. A staff member will follow up (e.g. via email).

---

## Common Use Cases

### Use Case 1: Finding USDA Programs

Get an overview of programs that might apply to you.

**Steps:**

1. Click **“What USDA programs are available?”** (or type a similar question).
2. Ask follow-ups, for example:
   - “What programs are there for beginning farmers?”
   - “How do I apply for conservation programs?”
3. Use the **citation links** to open official program pages.

---

### Use Case 2: Farm Loans and Financial Assistance

Learn about loans, grants, and disaster assistance.

**Steps:**

1. Click **“How do I apply for farm loans?”** or type “farm loan” or “FSA loan.”
2. Ask specifics, e.g.:
   - “What documents do I need for an FSA loan?”
   - “Is there disaster assistance for my county?”
3. Follow the cited links to application pages or contact info.

---

### Use Case 3: Food Safety and Reporting Issues

Find out how to report food safety concerns or learn about USDA’s role.

**Steps:**

1. Click **“How to report a food safety issue?”** or type “report food safety.”
2. Ask follow-ups if needed, e.g. “Who do I call for meat inspection?”
3. Use the sources to get contact details or reporting steps.

---

### Use Case 4: Local USDA Service Centers

Find offices near you.

**Steps:**

1. Click **“Find local USDA service centers”** or ask “Where is my nearest USDA office?”
2. Refine with location, e.g. “USDA service centers in [city] or [state].”
3. Use the links to get addresses, phone numbers, or service center locators.

---

### Use Case 5: Escalating Complex Questions

When the chatbot can’t fully help, request human support.

**Steps:**

1. Click the **✉️ Contact Support** button.
2. Fill in **name**, **email**, and **your question** (and phone if you want).
3. Submit the form.
4. Check your email for a reply from staff.

---

## Tips and Best Practices

- **Be specific**: “What farm loan programs exist for beginning farmers?” tends to work better than “Tell me about loans.”
- **Use follow-ups**: The chatbot keeps context within the conversation, so you can ask follow-up questions.
- **Check citations**: For important decisions (eligibility, deadlines, applications), open the source links and confirm on usda.gov or farmers.gov.
- **Use suggested questions**: They’re tuned to common USDA topics and can speed things up.
- **Give feedback**: Use 👍/👎 so the team can improve answers.

---

## Frequently Asked Questions (FAQ)

### Q: How accurate is the chatbot’s information?

**A:** The chatbot uses content from usda.gov and farmers.gov and cites sources. Always confirm important details (eligibility, deadlines, application steps) via the citation links or by contacting USDA directly.

### Q: Can I apply for programs or loans through the chatbot?

**A:** No. The chatbot only provides information. It will point you to official application pages, forms, or contact info. You must complete applications through those official channels.

### Q: Why does the chatbot say it doesn’t know something?

**A:** It only answers from its indexed USDA/farmers.gov content. If your question is outside that, or the info isn’t in the knowledge base, it will say so. Use **Contact Support** to reach a person.

### Q: Is my conversation private?

**A:** Conversations may be stored for analytics and improvement. Information you submit in the support form is used to follow up with you and is handled according to USDA privacy practices.

### Q: How do I report a wrong or unhelpful answer?

**A:** Click the **👎** (thumbs down) button on that response. This feedback is used to improve the chatbot.

### Q: Can I continue a conversation later?

**A:** Conversation history is kept only for your current browser session. If you close the tab or refresh, the history is cleared. You can start a new chat anytime.

---

## Troubleshooting

### The chatbot isn’t responding

- Check your internet connection.
- Refresh the page and try again.
- Clear cache or try a different browser if the issue continues.
- The service may be temporarily unavailable; try again later.

### Responses are slow

- Complex questions can take a few seconds.
- Check your connection speed.
- Try a shorter or simpler question to see if replies come through.

### Citations or links don’t work

- Ensure pop-ups aren’t blocked for the app’s domain.
- Click the link again; some sources may load slowly.
- If a link is broken, use the chatbot’s **Contact Support** to report it.

### Support form submission failed

- Make sure **name**, **email**, and **question** are filled in.
- Use a valid email address.
- Try again in a few moments. If it still fails, contact your system administrator.

---

## Admin Dashboard (Staff Only)

Authorized staff can sign in to the admin dashboard to view metrics, feedback, and escalation requests.

### Accessing the Dashboard

1. Go to **`/admin`** on the application URL (e.g. `https://master.xxx.amplifyapp.com/admin`).
2. Sign in with your **Cognito** credentials (email and password).
3. If you’re required to change a temporary password, follow the prompts.
4. After sign-in, you’re redirected to **`/dashboard`**.

### Dashboard Overview

The dashboard includes:

- **Metrics**: Total conversations, conversations today, feedback counts (positive, negative, none), satisfaction rate, average response time, and conversations by day.
- **Feedback**: List of conversations that have feedback. You can filter by positive, negative, or all, and open a row to see the full question, answer preview, and metadata.
- **Escalations**: List of support/escalation requests (name, email, phone, question, date). You can view details and delete resolved requests.

### Viewing Conversation Details

1. Open the **Feedback** section (or equivalent tab).
2. Click a conversation row to see full details (question, answer, feedback type, timestamp, etc.).
3. Use the feedback filter to show only positive, only negative, or all.

### Managing Escalation Requests

1. Open the **Escalations** section.
2. Click a request to view full details (name, email, phone, question).
3. Use **Reply via Email** (or similar) to respond to the user.
4. Delete a request when it’s resolved, if your workflow allows it.

---

## Getting Help

- **For general users**: Use the **Contact Support** option (✉️) in the chatbot to reach staff.
- **For technical or access issues**: Contact your system administrator.
- **For developers**: See the [Modification Guide](./modificationGuide.md).

---

## Next Steps

- [API Documentation](./APIDoc.md) — WebSocket and Admin API reference for integrators.
- [Architecture Deep Dive](./architectureDeepDive.md) — How the system is built.
- [Modification Guide](./modificationGuide.md) — How to customize or extend the application.
