LOCATEHUB ONLINE WEB APP — STARTER BUILD
========================================

WHAT THIS DOES
- A password-protected dashboard for the owner.
- Creates unique, expiring invitation links.
- A phone owner opens the invitation, reads the consent terms, checks consent,
  presses Start Sharing, and grants browser GPS permission.
- GPS updates are saved on the server; the dashboard refreshes every five seconds.
- Shows the latest position and a route made from recorded GPS points.
- Owner can revoke an invitation; phone owner can stop sharing.
- Uses Leaflet and OpenStreetMap for the map.

IMPORTANT LIMITATIONS
- This is a starter project, not a covert tracking tool.
- The phone owner must consent and grant location permission.
- Browser tracking may pause when the phone is locked, the browser is backgrounded,
  battery saver is active, or the browser closes. For reliable background tracking,
  build a dedicated mobile app with appropriate permissions and visible indicators.
- It cannot query carrier cell-tower data. The phone's own location service already blends GPS, Wi-Fi and
  mobile-network (cell) signals, and this app falls back to that automatically when GPS is weak.
- The map tiles and Leaflet JavaScript are loaded from public CDNs; the app requires
  internet access.
- GPS can be inaccurate indoors.
- This starter does not yet include multi-user accounts, email/SMS delivery, audit
  log exports, or a formal production security review.

RUN LOCALLY ON WINDOWS / VS CODE
1. Install Python 3.11 or newer.
2. Extract the ZIP into a folder and open that folder in VS Code.
3. Open Terminal > New Terminal.
4. Create a virtual environment:
      py -m venv .venv
      .venv\Scripts\activate
5. Install packages:
      pip install -r requirements.txt
6. Set a dashboard password in PowerShell for this terminal:
      $env:LOCATEHUB_PASSWORD="Choose-A-Strong-Password"
      $env:SECRET_KEY="use-a-long-random-secret-value"
7. Start:
      $env:FLASK_DEBUG="1"   (local testing only; never set this online)
      python app.py
8. On the same computer open:
      http://127.0.0.1:5000
9. Sign in with the password you configured.

Local testing note:
- The dashboard can be tested locally, but GPS sharing from a phone over the public
  internet requires deploying this app to an HTTPS host.
- Browsers generally allow geolocation on localhost, but not on arbitrary HTTP sites.

DEPLOY ONLINE (RECOMMENDED: RENDER + POSTGRESQL)
1. Create accounts on GitHub and Render, if needed.
2. Create a private GitHub repository and upload the extracted project files.
3. In Render, choose New > Blueprint and connect the repository containing render.yaml.
4. The blueprint requests a small PostgreSQL database. Check current Render pricing
   before creating resources; paid database plans may incur charges.
5. When prompted for LOCATEHUB_PASSWORD, set a long, unique dashboard password.
6. Render creates a public HTTPS URL for the web service. Wait until deployment succeeds.
7. Open that HTTPS URL on your PC and sign in.
8. Create an invitation, copy the full HTTPS link, and send it to the phone owner by
   WhatsApp, SMS, email, or another channel.
9. On the phone, open the link in a browser, read the notice, check the consent box,
   tap Agree and Start Sharing, then allow location access.
10. Keep the phone page open and the PC dashboard open while testing.

CONFIGURATION ENVIRONMENT VARIABLES
- SECRET_KEY: long random secret for session security. Required for deployment.
- LOCATEHUB_PASSWORD: dashboard password. Use a unique strong password.
- LOCATEHUB_PASSWORD_HASH: optional Werkzeug password hash; if set, it takes priority
  over LOCATEHUB_PASSWORD.
- DATABASE_URL: PostgreSQL connection string in deployment; SQLite is the local default.
- INVITE_HOURS: invitation lifetime in hours (default 24).

SECURITY BEFORE REAL-WORLD USE
- Use HTTPS only for remote use.
- Keep dashboard password private and strong.
- Treat invitation links like temporary access credentials; send only to the intended
  person and revoke a link when no longer needed.
- Location history is sensitive. Add retention/deletion controls and a privacy notice
  appropriate to your use case before production use.
- This starter uses a single shared dashboard password. Do not expose it to other users.
- Do not put real passwords or secrets into GitHub.

WHAT CHANGED IN THIS VERSION
- Fixed: Postgres connection (now uses the psycopg 3 driver), a date comparison that crashed on SQLite,
  debug mode no longer on by default, https invitation links behind Render (ProxyFix).
- App refuses to start online with the default password/secret. Login is rate-limited (5 tries / 10 min).
- Phone page: keeps the screen awake, falls back to Wi-Fi/mobile-network location when GPS is weak,
  stores points while offline and sends them when the connection returns.
- Dashboard: updates every 3 s, accuracy circle, speed (km/h), distance travelled, follow mode,
  'Signal lost' warning after 45 s, and a Delete history button.
- Location history older than RETENTION_DAYS (default 30) is deleted at startup.
- Mac/Linux local run: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
  then: SECRET_KEY=abc LOCATEHUB_PASSWORD=pick-one FLASK_DEBUG=1 python app.py
