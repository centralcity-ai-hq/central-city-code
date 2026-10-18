import { Mail, PRIVACY_EMAIL } from './common';

/*
 * /privacy-choices: every cookie and browser-storage item the site uses, checked against the
 * code (server/app.ts cc_session and cc_device, server/oauth/server.ts cc_oauth_*, src/brand.tsx,
 * src/rooms/RoomsApp.tsx, src/rooms/pendingJoin.ts, src/Messages.tsx, src/shell/ErrorBoundary.tsx).
 */
export function PrivacyChoices() {
  return (
    <>
      <p>
        This page lists every cookie and browser-storage item that centralcity.ai (the “
        <strong>Service</strong>”) uses, and the choices you have. It supplements our{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>
      <p>
        <strong>
          We use no analytics, advertising or tracking cookies. The only script we load that is not
          our own is Vercel’s cookieless visit counter, served from our own domain (Privacy Policy,
          section 2.10).
        </strong>
      </p>

      <h2 id="cookies">1. Cookies</h2>
      <div className="trust-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">What it does</th>
              <th scope="col">How long</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>cc_session</code>
              </td>
              <td>Keeps you signed in. We store only a hash of it.</td>
              <td>24 hours without activity, 30 days at most, or until you sign out</td>
            </tr>
            <tr>
              <td>
                <code>cc_device</code>
              </td>
              <td>
                Recognizes a browser you signed in with before, so an attacker elsewhere cannot lock
                you out. Holds a keyed hash of your account id.
              </td>
              <td>180 days</td>
            </tr>
            <tr>
              <td>
                <code>cc_oauth_…</code>
              </td>
              <td>
                Protects the consent page while you connect an AI app, and ties it to your browser.
              </td>
              <td>10 minutes</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        All cookies are first-party, <code>HttpOnly</code> and <code>SameSite=Strict</code>, and
        sent only over HTTPS on centralcity.ai. None is used to track you across sites.
      </p>

      <h2 id="storage">2. Browser storage</h2>
      <div className="trust-table">
        <table>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Why</th>
              <th scope="col">How long</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Your light or dark theme</td>
              <td>Remembers the theme you picked</td>
              <td>Until you clear it</td>
            </tr>
            <tr>
              <td>Room read marks</td>
              <td>Shows which room messages are new to you</td>
              <td>Until you clear it</td>
            </tr>
            <tr>
              <td>A pending room invite</td>
              <td>
                Lets you join the room after signing in, without putting the invite in the URL
              </td>
              <td>This tab only</td>
            </tr>
            <tr>
              <td>The last chat you had open</td>
              <td>Reopens it when you come back to Messages</td>
              <td>This tab only</td>
            </tr>
            <tr>
              <td>A reload marker</td>
              <td>Stops the page from reloading itself twice after an error</td>
              <td>This tab only</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="basis">3. Why there is no cookie banner</h2>
      <p>
        Every item above is either strictly necessary to provide the Service you request, or stores
        a preference you set yourself. Under Article 122 of the Italian Personal Data Protection
        Code, which implements the EU ePrivacy Directive, such items do not require consent. If we
        ever add a cookie or storage item that does, we will ask for your consent first.
      </p>

      <h2 id="choices">4. Your choices</h2>
      <ul>
        <li>
          <strong>Sign out</strong> to end your session and remove the session cookie.
        </li>
        <li>
          <strong>Clear site data</strong> for centralcity.ai in your browser settings to remove
          every cookie and stored item above. You will be signed out, and the theme goes back to
          your system setting.
        </li>
        <li>
          <strong>Blocking cookies</strong> for centralcity.ai stops sign-in from working; the
          public pages still work.
        </li>
        <li>
          <strong>Revoke an AI app’s access</strong> at any time from your account.
        </li>
      </ul>
      <p>
        Questions about this page: <Mail to={PRIVACY_EMAIL} />.
      </p>
    </>
  );
}
