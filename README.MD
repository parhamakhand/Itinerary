# AI Travel Itinerary Generator

This project is a serverless application built on Cloudflare Workers that generates a travel itinerary using Google's Gemini AI. It accepts a destination and trip duration, processes the request asynchronously, and saves the structured itinerary to a Google Firestore database.

---

## Core Technologies

- **Compute:** Cloudflare Workers
- **AI Model:** Google Gemini 1.5 Flash
- **Database:** Google Cloud Firestore

---

## 🚀 Getting Started

Follow these instructions to set up and run the project locally.

### Prerequisites

- [Node.js](https://nodejs.org/en/) (v18 or later)
- A [Cloudflare account](https://www.google.com/search?q=https://dash.cloudflare.com/sign-up)
- A [Google Cloud Platform (GCP) account](https://cloud.google.com/) with a project created
- The [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed (`npm install -g wrangler`)

### 1\. Setup

First, clone the repository to your local machine and install the necessary dependencies.

```bash
# Clone the repository
git clone <your-repository-url>

# Navigate into the project directory
cd itinerary-worker

# Install dependencies
npm install
```

### 2\. Environment Variables

This project requires three environment variables to connect to Google Cloud services. Create a file named `.dev.vars` in the root of the project directory to store these secrets for local development.

> **Important:** The `.dev.vars` file should be added to your `.gitignore` file to prevent committing secrets to version control.

```sh
# .dev.vars

GCP_PROJECT_ID="your-gcp-project-id"
GEMINI_API_KEY="your-gemini-api-key"
GCP_KEY_JSON='{"type": "service_account", "project_id": "...", ...}'
```

#### **How to get these values:**

1.  **`GCP_PROJECT_ID`**:

    - This is the ID of your project in the Google Cloud Console. You can find it on the main dashboard.

2.  **`GEMINI_API_KEY`**:

    - Go to [Google AI Studio](https://aistudio.google.com/).
    - Click "**Get API key**" and create a new key within your GCP project.
    - Copy the key and paste it as the value for `GEMINI_API_KEY`.

3.  **`GCP_KEY_JSON`**:

    - This is a JSON key for a **Service Account** that grants the worker permission to access Firestore.
    - In the GCP Console, navigate to **IAM & Admin \> Service Accounts**.
    - Click **+ CREATE SERVICE ACCOUNT**.
    - Give it a name (e.g., `firestore-worker-sa`) and click **CREATE AND CONTINUE**.
    - For the role, select **Cloud Datastore User**. This provides the necessary permissions for reading and writing to Firestore.
    - Click **DONE**.
    - Find your newly created service account in the list, click the three-dot menu under "Actions", and select **Manage keys**.
    - Click **ADD KEY \> Create new key**.
    - Choose **JSON** as the key type and click **CREATE**. A JSON file will be downloaded.
    - Open the downloaded JSON file, copy its **entire contents**, and paste it as the value for `GCP_KEY_JSON` inside the single quotes.

### 3\. Running Locally

Once your `.dev.vars` file is configured, you can start the local development server.

```bash
npx wrangler dev
```

The worker will now be running and accessible at `http://127.0.0.1:8787`.

---

## 🏗️ Architecture & Design

### Architectural Choices

The architecture is designed to be **highly scalable, resilient, and cost-effective** by leveraging a fully serverless stack.

- **Asynchronous Processing:** The core design principle is to provide an immediate response to the user. When a request is received, the API instantly returns a `202Accepted` status with a unique `jobId`. The actual work of calling the LLM and writing to the database is performed in the background using Cloudflare's `ctx.waitUntil()`. This prevents long-running requests from timing out and creates a responsive user experience.

- **State Management with Firestore:** Firestore acts as the state machine for each job. A document is created immediately with a `processing` status. Once the background task completes, the same document is updated with either a `completed` status and the itinerary data, or a `failed` status and an error message. This provides a durable and observable record of each request.

### Prompt Design

The reliability of the application depends entirely on forcing the LLM to return a predictable, parsable JSON object. The prompt was engineered with the following strategy:

1.  **Explicit Instruction:** The prompt begins with a critical, unambiguous instruction: `Your entire response MUST be a single, raw JSON object. Do not add any commentary, markdown, or any text outside of the JSON.`.
2.  **Schema Definition:** It clearly defines the required root key (`itinerary`) and the nested structure, including data types for each field (e.g., `(Integer)`, `(String)`, `(Array)`).
3.  **Example-Driven (Few-Shot Prompting):** The most crucial technique used is providing a perfect, well-structured example of the desired output. This "shows" the model the exact format required, which is far more effective than simply "telling" it. This drastically increases the reliability of receiving a valid JSON response that conforms to the application's data contract.

---

## 📖 API Usage

To generate a new travel itinerary, send a `POST` request to the worker's endpoint with a JSON body specifying the `destination` and `durationDays`.

### cURL Example

Here is an example of how to call the API from your terminal.

```bash
curl -X POST http://127.0.0.1:8787 \
-H "Content-Type: application/json" \
-d '{
  "destination": "Tokyo",
  "durationDays": 5
}'
```

### Successful Response

If the request is valid, the API will immediately respond with a `202 Accepted` status and a `jobId`.

```json
{
	"jobId": "b631935d-8cb8-4b24-a22c-4f0f190ec844"
}
```

You can then use this `jobId` to look up the document in your `itineraries` collection in the Firestore console to see the final result once the background job is complete.
