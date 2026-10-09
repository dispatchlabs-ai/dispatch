import { join } from "node:path";
import { parseArgs } from "node:util";
import { readAuthStoreConfig, openConfiguredAuth } from "./auth/config.js";
import { createAuth } from "./auth.js";
import { readConfig } from "./config.js";

const help = `Dispatch account enrollment

  npm run auth -- invite --email person@example.com [--name "Person"] [--hours 1]
  npm run auth -- reset --email person@example.com --confirm-reset [--hours 1]

Invitations are single-use and expire after one hour by default (maximum 24).
Share the link privately with its intended account owner. The browser must
complete password + TOTP or a user-verified passkey before receiving app access.

Reset is an operator recovery action. Independently verify the account owner's
identity first. It immediately revokes that account's sessions and suspends its
existing sign-in methods until the owner completes fresh factor enrollment.

The command uses DISPATCH_DATA_DIR, DISPATCH_ORIGIN, and company settings from
the same configuration as the application. No password is accepted on the CLI.
For PostgreSQL, supply --auth-store-config with the backend authStoreConfigFile.
When DISPATCH_BACKEND_WORKERS_CONFIG_FILE is set, explicit selection is required
to avoid silently targeting SQLite; use --sqlite only for intentional local access.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "auth-store-config": { type: "string" },
      sqlite: { type: "boolean", default: false },
      email: { type: "string" },
      name: { type: "string" },
      hours: { type: "string", default: "1" },
      "confirm-reset": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
  } else {
    if (positionals.length !== 1 || !["invite", "reset"].includes(command) || !values.email) {
      throw new Error("Use invite or reset with --email. Run with --help for usage.");
    }
    if (command === "reset" && !values["confirm-reset"]) {
      throw new Error("Reset requires --confirm-reset after independently verifying the account owner.");
    }
    const hours = Number(values.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error("--hours must be greater than zero and at most 24.");
    if (values["auth-store-config"] && values.sqlite) throw new Error("Choose --auth-store-config or --sqlite, not both.");
    if (process.env.DISPATCH_BACKEND_WORKERS_CONFIG_FILE && !values["auth-store-config"] && !values.sqlite)
      throw new Error("Backend configuration is present; explicitly select --auth-store-config or --sqlite.");
    const config = readConfig();
    const auth = values["auth-store-config"]
      ? await openConfiguredAuth(await readAuthStoreConfig(values["auth-store-config"]), config)
      : await createAuth({
      databasePath: join(config.stateDir, "auth.sqlite"),
      secretPath: join(config.stateDir, "auth.key"),
      origin: config.origin,
      rpId: config.rpId,
      companyId: config.companyId,
      companyName: config.companyName,
    });
    try {
      await auth.resume();
      if (!auth.admitting) throw new Error("Authentication admission remains closed.");
      const input = { email: values.email, name: values.name, expiresInMs: Math.floor(hours * 60 * 60_000) };
      const invitation = command === "reset" ? await auth.issueRecoveryInvitation(input) : await auth.issueInvitation(input);
      console.log(`Single-use ${command === "reset" ? "recovery" : "enrollment"} link; expires ${new Date(invitation.expiresAt).toISOString()}:`);
      console.log(invitation.url);
    } finally {
      await auth.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Account enrollment failed.");
  process.exitCode = 1;
}
