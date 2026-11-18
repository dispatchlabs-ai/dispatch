# Dispatch for iPhone

Use your iPhone to pick an agent, start a conversation or continue one you opened in Dispatch Web. The SwiftUI app reads the agent catalog and history from your own Dispatch Web installation. Your agent definitions, tools and model credentials stay on your host.

## Run on your iPhone

1. On a Mac with Xcode and the iOS SDK for your device, get the app source. The Xcode project is ready to open and uses only Apple frameworks.

   ```sh
   git clone https://github.com/dispatchlabs-ai/dispatch.git
   cd dispatch
   open apps/ios/Dispatch.xcodeproj
   ```

2. In Xcode, add your Apple Account under **Xcode → Settings → Accounts**. Select the **Dispatch** project, the **Dispatch** app target, then **Signing & Capabilities**. Leave **Automatically manage signing** enabled, select your team and replace `com.example.DispatchPhone` with a unique bundle identifier you control. Keep these choices in your checkout.
3. Connect your iPhone (iOS 18 or later), select it as the run destination for the **Dispatch** scheme and choose **Product → Run**. Follow Xcode’s pairing or Developer Mode prompts if they appear. Xcode installs this development build directly on your phone. [Running on a device](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)
4. Tap **Connect to Dispatch**, enter the root HTTPS address and the username and password for your Dispatch Web installation, then tap **Connect to Dispatch**. If you normally use a private network or VPN to reach the site, connect the phone to it first.
5. Tap the compose button, choose one of your agents and send a message. Open the same conversation in Dispatch Web to continue it from your browser. Agent changes on the host also appear on your iPhone.

The app keeps its sign-in credential in the iPhone Keychain. Saved conversations, drafts and pending sends are scoped to the server and username. **Settings** lets you sign out or connect to another installation. Reopening a conversation observes ongoing work. If a send loses its acknowledgement, **Retry message** reuses the original request identity.

## Connect your agents repo

If you already use Dispatch Web with its hosted username/password sign-in and a trusted HTTPS address reachable from your iPhone, use that address in step 4. Each user can build this same project and point it at their own installation.

For a new agents repo, follow the [Dispatch quickstart](../../README.md#quickstart) to install the host and Web packages. Keep using your usual host command (`npx dispatch serve` in the quickstart). The default Web address, `127.0.0.1`, reaches only the machine running Web. To make your private Web installation reachable from a phone:

1. Use a DNS name that resolves from the iPhone and a TLS reverse proxy with a certificate the iPhone trusts. For example, have `https://chat.example.com` proxy to `127.0.0.1:4319` on the Web machine. Preserve the original Host and Origin and forward event streams without buffering.
2. Create the shipped session module’s credential file once. Run this from your agents repo as the user that runs Web. It creates a private directory and a login named `owner`, then prints a generated password once. Save that password in your password manager. Keep `.state/` out of Git.

   ```sh
   node --input-type=module <<'JS'
   import { mkdirSync, writeFileSync } from 'node:fs';
   import { randomBytes, scryptSync } from 'node:crypto';
   const dir = '.state/web-auth';
   mkdirSync(dir, { recursive: true, mode: 0o700 });
   const password = randomBytes(24).toString('base64url');
   const salt = randomBytes(16);
   const hash = scryptSync(password, salt, 64).toString('hex');
   writeFileSync(dir + '/login.json', JSON.stringify({
     username: 'owner', salt: salt.toString('hex'), hash
   }), { flag: 'wx', mode: 0o600 });
   console.log(password);
   JS
   ```

3. Start Web from the same directory, using your real HTTPS origin. Keep these environment settings with your private deployment. If your host uses a configuration file, pass it to Web as usual, for example `npx dispatch-web --config host.json`.

   ```sh
   export DISPATCH_ORIGIN=https://chat.example.com
   export DISPATCH_HOST=127.0.0.1
   export DISPATCH_PORT=4319
   export DISPATCH_AUTH_MODULE="$PWD/node_modules/@dispatch/web/dist/server/server/session-auth.js"
   export DISPATCH_SESSION_AUTH_FILE="$PWD/.state/web-auth/login.json"
   export DISPATCH_SESSION_STATE_FILE="$PWD/.state/web-auth/sessions.json"
   npx dispatch-web
   ```

4. If your agents repo uses a user roster, link the verified Web username to its person with a Web channel identity such as `{"channel":"web","scope":"https://chat.example.com","handle":"owner"}`, then restart the host. Open the HTTPS site in Safari on the iPhone and sign in to confirm the address and credentials. Use the same values in the app. [Hosted Web configuration](../../packages/web/docs/usage-guide.md#configuration) · [Shared human identities](../../packages/runner/docs/service.md#shared-human-identities)
