# Holiday Potluck

Free sign-up sheets for holiday potlucks. Anyone can start a group from the front page. They share a code or link with their guests, and everyone signs up for what they're bringing. The organizer picks the holiday, and the whole site changes its colors, icon and menu to match. Each holiday keeps its own list.

**Holidays:** New Year's Day, Valentine's Day, Easter, Memorial Day, Fourth of July, Labor Day, Halloween, Thanksgiving, Christmas, and a "Special gathering" for birthdays or anything else. **Automatic** mode always shows the next holiday coming up, and it switches over the day after each one.

## Features
- **Groups.** The front page has *Join your group* (enter a code) and *Start a potluck* (group name, group code, organizer PIN). Each group's people, menus, RSVPs and settings are completely separate.
- **Share links.** `https://your-site/?code=smith-thanksgiving` takes guests straight into a group.
- **No accounts.** Guests sign in with just their name, and their device remembers them. A 4-digit PIN is optional and only needed to sign in as the same person on another device. Nobody can take a name that's already in use. Five wrong PINs locks that name for 10 minutes, and organizers can reset anyone's sign-in.
- **Guided setup.** New organizers walk through four steps: the occasion (a holiday, or "Something else" with a custom name), when and where, what they need (with Small / Family / Big party presets), and the invite link. A checklist stays on the page until setup is done.
- **Manage panel.** Organizers get a **Manage** button with tabs for Event, What we need, People and Sharing. When a holiday comes around again, they can copy last year's setup.
- **Guest helpers.** Dish ideas for each holiday and category, **Add to calendar** (Google, Apple/.ics, Outlook), an **Invite** button that uses the phone's share sheet, a **Print menu** page, and "Your groups" on the front page for anyone in more than one group.
- **The menu.** Dishes are sorted into categories with dietary tags, a "serves" amount and a note. The site warns people before they add a duplicate. RSVPs include adult and kid counts. Organizers can set how many of each category they need, which shows a "Still needed" list.
- **Organizer settings.** The holiday switcher, the date, time, place, host and notes, the invite link, changing the group code or organizer PIN, PIN resets, removing people, and deleting the group.
- **Spam protection.** Five new groups per visitor per day, a site-wide cap (`MAX_GROUPS`), a hidden bot trap, and a lockout after too many wrong group codes or organizer PINs.
- Every pop-up is styled to match the site. None of them are the browser's built-in boxes.

## Deploy (Vercel)
1. Import this repo in Vercel. No build settings are needed.
2. **Database:** in Vercel → **Storage**, open your Upstash Redis database, click **Connect Project**, and choose this project. It can share a database with other sites, such as Secret Santa, because everything is stored under keys starting with `pl:`.
3. In **Settings → Environment Variables**:
   - `ADMIN_PIN`: the site owner's master PIN. It opens organizer settings for **any** group, which helps if an organizer forgets theirs. Keep it secret.
   - Optional `GROUP_CODE` (or `FAMILY_CODE`): a built-in group whose code lives in Vercel and whose organizer PIN is `ADMIN_PIN`. Groups created on the site don't need this.
   - Optional: `SITE_NAME` (default "Holiday Potluck"), `MAX_GROUPS` (default 1000), `KEY_PREFIX` (default `pl:`), `TIMEZONE` (default `America/Chicago`).
4. **Redeploy** so the variables take effect.

## Usage limits
Each open page checks for updates every 20 seconds. On the free Upstash plan that's plenty for many small groups. If the site gets popular, watch the request count in the Upstash dashboard.

## Files
- `index.html` contains the whole front end.
- `api/potluck.js` is the one serverless function. It talks to Upstash through its REST API and needs no packages.
