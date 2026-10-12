import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOCS } from "./content.js";
import * as hinge from "./hinge.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// Tool errors go back to the model as text so it can recover (e.g. re-run login).
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /status 401/.test(message) ? " Check hinge_status before starting a new login." : "";
    return { ...text(`Error: ${message}${hint}`), isError: true };
  }
}

const DOC_KEYS = Object.keys(DOCS) as [string, ...string[]];
const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const WRITE_NOTE =
  " This changes the live Hinge profile. Show the user the exact change and get explicit confirmation before calling.";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "hinge-profile-optimizer", version: "0.1.1" },
    {
      instructions:
        "Hinge Profile Optimizer. Read get_optimizer_guide (section 'skill') before coaching. " +
        "To work on the live profile: hinge_status, then hinge_login_start / hinge_login_verify if needed, then hinge_get_profile. " +
        "An accepted SMS request does not confirm sending or delivery. Never claim the code was sent. Do not automatically retry SMS. " +
        "Never call a hinge_update_* or hinge_delete_* tool without showing the user the exact change and getting a clear yes.",
    }
  );

  // Skill content
  server.registerTool(
    "get_optimizer_guide",
    {
      title: "Get optimizer guide",
      description:
        "Return the Hinge Profile Optimizer playbook. 'skill' is the main process; the rest are reference files " +
        "(audit-criteria, copy-principles, discovery-questions, hinge-prompts-current, hinge-settings, photo-guidelines, research-findings).",
      inputSchema: { section: z.enum(DOC_KEYS).default("skill") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ section }) => text(DOCS[section])
  );

  for (const key of DOC_KEYS) {
    server.registerResource(
      key,
      `hinge-optimizer://docs/${key}`,
      { title: key === "skill" ? "Hinge Profile Optimizer skill" : key, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: DOCS[key] }] })
    );
  }

  server.registerPrompt(
    "optimize_hinge_profile",
    {
      title: "Optimize my Hinge profile",
      description: "Start the full Hinge profile optimization process.",
      argsSchema: { goal: z.string().optional() },
    },
    ({ goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `${DOCS.skill}\n\n---\nFollow the skill above. You can read reference files with get_optimizer_guide and ` +
              `pull my live profile with hinge_get_profile (log in first if hinge_status says so).` +
              (goal ? `\n\nMy goal: ${goal}` : ""),
          },
        },
      ],
    })
  );

  // Hinge login
  server.registerTool(
    "hinge_status",
    { title: "Hinge login status", description: "Check stored Hinge token expiry and the last SMS request diagnostics. Does not send an SMS or check token revocation.", annotations: READ },
    () => run(() => hinge.status())
  );

  server.registerTool(
    "hinge_login_start",
    {
      title: "Start Hinge login",
      description: "Prepare Hinge login. With send_sms=true, request an SMS; HTTP success does not confirm delivery. If no code arrives, use send_sms=false and ask the user to request a code in the official Hinge app, then submit it with hinge_login_verify. This is a reported workaround, not guaranteed. Never automatically resend.",
      inputSchema: {
        phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/, "E.164 format, e.g. +919812345678"),
        send_sms: z.boolean().default(true).describe("False prepares login without an SMS request, to try a code requested in the official Hinge app."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ phone_number, send_sms }) => run(() => hinge.loginStart(phone_number, send_sms))
  );

  server.registerTool(
    "hinge_login_verify",
    {
      title: "Verify Hinge SMS code",
      description: "Submit the SMS code from hinge_login_start. May ask for an email code next (hinge_login_email).",
      inputSchema: { code: z.string().regex(/^\d{4,10}$/, "Code must contain 4 to 10 digits") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ code }) => run(() => hinge.loginVerify(code))
  );

  server.registerTool(
    "hinge_login_email",
    {
      title: "Verify Hinge email code",
      description: "Submit the email verification code when hinge_login_verify asks for one.",
      inputSchema: { code: z.string().regex(/^\d{4,10}$/, "Code must contain 4 to 10 digits") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ code }) => run(() => hinge.loginEmail(code))
  );

  server.registerTool(
    "hinge_logout",
    {
      title: "Log out of Hinge",
      description: "Delete the stored Hinge session from this server.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    () => run(async () => (await hinge.logout(), "Hinge session deleted."))
  );

  // Hinge reads
  server.registerTool(
    "hinge_get_profile",
    {
      title: "Get my Hinge profile",
      description: "Fetch the logged-in user's profile (basics, vitals) and content (photos, prompt answers).",
      annotations: READ,
    },
    () =>
      run(() =>
        hinge.withHinge(async (c) => {
          const [profile, content] = await Promise.all([c.profiles.me(), c.profiles.content()]);
          return { profile, content };
        })
      )
  );

  server.registerTool(
    "hinge_get_preferences",
    { title: "Get my dating preferences", description: "Fetch the logged-in user's dating preferences and dealbreakers.", annotations: READ },
    () => run(() => hinge.withHinge((c) => c.profiles.preferences()))
  );

  server.registerTool(
    "hinge_get_settings",
    { title: "Get my Hinge settings", description: "Fetch account settings and user traits.", annotations: READ },
    () =>
      run(() =>
        hinge.withHinge(async (c) => {
          const [settings, traits] = await Promise.all([c.settings.content(), c.settings.userTraits()]);
          return { settings, traits };
        })
      )
  );

  server.registerTool(
    "hinge_search_prompts",
    {
      title: "Search Hinge prompts",
      description: "Search Hinge's live prompt catalog by text, or list a category. With no arguments, lists categories.",
      inputSchema: { query: z.string().optional(), category: z.string().optional() },
      annotations: READ,
    },
    ({ query, category }) =>
      run(() =>
        hinge.withHinge(async (c) => {
          const manager = await c.prompts.manager();
          if (query) return manager.searchPrompts(query);
          if (category) return manager.getPromptsByCategory(category);
          return (manager.promptsData as { categories?: unknown }).categories ?? manager.promptsData;
        })
      )
  );

  server.registerTool(
    "hinge_api_get",
    {
      title: "Raw Hinge GET",
      description: "GET any Hinge API path (e.g. /user/v3). Use to inspect payload shapes before an update.",
      inputSchema: { path: z.string().regex(/^\/[\w\-/.?=&,]*$/, "path like /user/v3") },
      annotations: READ,
    },
    ({ path }) => run(() => hinge.withHinge((c) => c.raw.hinge("GET", path)))
  );

  // Hinge writes
  server.registerTool(
    "hinge_update_profile",
    {
      title: "Update my Hinge profile",
      description:
        "PATCH profile fields (e.g. hometown, datingIntention, drinking, height). Fields use the shapes returned by " +
        "hinge_get_profile; visible fields look like { value, visible }." + WRITE_NOTE,
      inputSchema: { profile: z.record(z.string(), z.unknown()) },
      annotations: WRITE,
    },
    ({ profile }) => run(() => hinge.withHinge((c) => c.profiles.update(profile)))
  );

  server.registerTool(
    "hinge_update_answers",
    {
      title: "Update my prompt answers",
      description:
        "Replace prompt answers (PUT /content/v1/answers). Send the FULL list of answers to keep, mirroring the answer " +
        "objects from hinge_get_profile content, with changed text or promptId. Omitted answers may be removed." + WRITE_NOTE,
      inputSchema: { answers: z.array(z.record(z.string(), z.unknown())).min(1).max(3) },
      annotations: WRITE,
    },
    ({ answers }) => run(() => hinge.withHinge((c) => c.profiles.updateAnswers(answers)))
  );

  server.registerTool(
    "hinge_update_preferences",
    {
      title: "Update my dating preferences",
      description: "PATCH dating preferences (age/height ranges, distance, dealbreakers). Use shapes from hinge_get_preferences." + WRITE_NOTE,
      inputSchema: { preferences: z.record(z.string(), z.unknown()) },
      annotations: WRITE,
    },
    ({ preferences }) => run(() => hinge.withHinge((c) => c.profiles.updatePreferences(preferences)))
  );

  server.registerTool(
    "hinge_update_settings",
    {
      title: "Update my Hinge settings",
      description: "Update account settings. Send the full settings object from hinge_get_settings with changes applied." + WRITE_NOTE,
      inputSchema: { settings: z.record(z.string(), z.unknown()) },
      annotations: WRITE,
    },
    ({ settings }) => run(() => hinge.withHinge((c) => c.settings.updateContent(settings)))
  );

  server.registerTool(
    "hinge_delete_content",
    {
      title: "Delete profile content",
      description: "Permanently delete photos or prompt answers by content id (from hinge_get_profile)." + WRITE_NOTE,
      inputSchema: { content_ids: z.array(z.string()).min(1).max(6) },
      annotations: WRITE,
    },
    ({ content_ids }) => run(async () => (await hinge.withHinge((c) => c.profiles.deleteContent(content_ids)), "Deleted."))
  );

  return server;
}
