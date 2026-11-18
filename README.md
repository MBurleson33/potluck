# Holiday Potluck

Family members sign in and say what food they're bringing to holiday gatherings. The organizer picks the holiday, and the whole site changes its colors, icon and list to match. Each holiday keeps its own list.

**Holidays:** New Year's Day, Valentine's Day, Easter, Memorial Day, Fourth of July, Labor Day, Halloween, Thanksgiving, Christmas, and a "Special gathering" for birthdays or anything else. **Automatic** mode always shows the next holiday coming up, and it switches over the day after each one.

## Features
- A shared family code to get in. There are no accounts. Each person picks a name and a 4-digit PIN so only they can change their own dishes. Five wrong PINs locks that name for 10 minutes.
- Dishes are sorted into categories like mains, sides and desserts, with dietary tags, a "serves" amount and a note.
- If someone adds a dish that's already on the list, the site warns them first.
- RSVPs with adult and kid counts, plus a running headcount.
- The organizer can set how many of each category they need, for example 4 sides and 3 desserts. The site then shows a "Still needed" list.
- The organizer screen has the holiday switcher, the date, time, location, host and notes, PIN resets, and removing people. In organizer mode you can edit or remove any dish.
- The list refreshes every 20 seconds, so everyone sees new dishes.
- Every pop-up is styled to match the site. None of them are the browser's built-in boxes.

## Deploy (Vercel)
1. Push this folder to a GitHub repo and import it in Vercel. No build settings are needed.
2. **Database:** in Vercel → **Storage**, open your existing Upstash Redis database, click **Connect Project**, and choose this project. It shares the database with Secret Santa safely, because this site's keys start with `pl:` and Secret Santa's start with `ss:`.
3. In the project → **Settings → Environment Variables**, add:
   - `FAMILY_CODE`: what people type to get in.
   - `ADMIN_PIN`: your organizer password.
   - Optional: `KEY_PREFIX` (default `pl:`) and `TIMEZONE` (default `America/Chicago`).
4. **Redeploy** so the variables take effect.
5. Open the site, tap **Organizer** at the bottom, and set the holiday and details.

## Files
- `index.html` contains the whole front end.
- `api/potluck.js` is the one serverless function. It talks to Upstash through its REST API and needs no packages.
