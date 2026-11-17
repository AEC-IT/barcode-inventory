# Run the barcode app on the office PC (Windows)

The app and its database run on one Windows PC in the Alappuzha office.
Phones anywhere (Ernakulam, Kochi, anywhere with internet) use it through a
permanent, secure web address from **Tailscale Funnel**. Hosting cost: zero.
Storage: the PC's hard disk. No monthly quotas or lockouts.

Photos keep going to SharePoint as now. A full database backup is copied to
SharePoint every night.

**The PC must stay on, connected to the internet, and logged in.** If it's off,
scanning stops everywhere until it's back.

Time needed: about 1 hour, done once.

---

## Part 1: Install the software

Download and install each with the default options:

1. **PostgreSQL 17** (version 17 or newer, so it can copy from Neon): https://www.postgresql.org/download/windows/ (EDB installer).
   - When asked, set a password for the `postgres` user. **Write it down.**
   - Keep port **5432**. You can untick "Stack Builder" at the end.
2. **Node.js LTS**: https://nodejs.org (the "LTS" button).
3. **Git**: https://git-scm.com/download/win
4. **Tailscale**: https://tailscale.com/download/windows. Sign in with the company
   Microsoft or Google account when it asks.

## Part 2: Get the app

Open **Command Prompt** and run:

```
cd C:\
git clone https://github.com/AEC-IT/barcode-inventory.git
cd C:\barcode-inventory
npm install
```

(If GitHub asks you to sign in, use the AEC-IT account.)

## Part 3: Create the database

In Command Prompt:

```
"C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres eams
```

Enter the postgres password from Part 1.

## Part 4: Settings file

In `C:\barcode-inventory`, create a file named **`.env`** (Notepad, then "Save as",
type `.env` with the quotes as `".env"`) containing:

```
DATABASE_URL=postgresql://postgres:YOUR-POSTGRES-PASSWORD@localhost:5432/eams
PGSSLMODE=disable
PORT=3000
SESSION_SECRET=any-long-random-text-here
MS_TENANT_ID=(same value as on Render)
MS_CLIENT_ID=(same value as on Render)
MS_CLIENT_SECRET=(same value as on Render)
SHAREPOINT_SITE=https://aecedu365.sharepoint.com/sites/AssetPhotosbarcodescanner
```

Copy the four `MS_`/`SHAREPOINT_` values from Render, **barcode-inventory → Environment**.

## Part 5: Bring your data over (on or after 1 December)

Neon's database is locked until 1 December. On that day, in Command Prompt
(paste your Neon connection string from Render's `DATABASE_URL`):

```
cd C:\barcode-inventory
"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -Fc --no-owner --no-acl -d "PASTE-NEON-CONNECTION-STRING" -f neon-copy.backup
"C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" -U postgres -d eams --no-owner --no-acl neon-copy.backup
```

All assets, scans, users, bills and the audit log come across. Photos already
in SharePoint keep working; any still inside the database come too.

(Starting before 1 December? Skip this part: the app starts with an empty
database and default login `superadmin` / `super123`. **Change that password
immediately.** You can still do Part 5 later, but only into a fresh, empty
database, which would replace anything entered meanwhile.)

## Part 6: Test it on the PC

```
cd C:\barcode-inventory
node server.js
```

Wait for `Database: connected to Postgres`, open http://localhost:3000 and log in.
Then press **Ctrl+C** to stop it.

## Part 7: Put it on the internet (Tailscale Funnel)

In Command Prompt **run as administrator**:

```
tailscale funnel --bg 3000
```

The first time, it prints a link to enable Funnel for your account. Open it,
approve it, and run the command again. It then shows your permanent address,
like:

```
https://office-pc.tail1a2b3c.ts.net
```

**That is the new scanner address.** Open it on a phone using mobile data (not office
Wi-Fi) to confirm it works from outside. The `--bg` setting survives restarts.

## Part 8: Start automatically and back up nightly

1. Open `C:\barcode-inventory\windows\backup-database.bat` in Notepad and set:
   - `PGPASSWORD` to your postgres password
   - `BACKUP_DIR` to a SharePoint folder synced to this PC. In SharePoint, open
     **Asset Photos barcode scanner → Documents**, click **Sync**, create a folder
     **Database Backups**, and copy its path from File Explorer.
2. In Command Prompt **run as administrator**:

```
schtasks /create /tn "AEC Barcode Inventory" /tr "C:\barcode-inventory\windows\start-server.bat" /sc onstart /ru SYSTEM /rl HIGHEST
schtasks /create /tn "AEC Barcode Backup" /tr "C:\barcode-inventory\windows\backup-database.bat" /sc daily /st 23:00
schtasks /run /tn "AEC Barcode Inventory"
```

## Part 9: Keep the PC awake

**Settings → System → Power** (or Power & sleep):

- Screen: any setting
- **Sleep: Never** (when plugged in)

Also, in **Windows Update → Advanced options**, set **Active hours** to your
working hours so updates restart the PC at night. After a restart, the app,
database and Tailscale all start on their own.

## Part 10: Switch everyone over

1. Share the new Tailscale address with the team.
2. Check the next morning that a backup file appeared in **Database Backups**.
3. Suspend the Render service (**Settings → Suspend**) so nobody uses the old link.

---

## Day to day

| Check | Where |
| --- | --- |
| Is it running? | Open the Tailscale address |
| App log | `C:\barcode-inventory\logs\server.log` |
| Backups | SharePoint → Asset Photos barcode scanner → Documents → Database Backups |
| Update the app | `cd C:\barcode-inventory`, then `git pull`, `npm install`, and restart the PC |

## If the PC dies

Install the software on another PC (Parts 1–4, 6–9), then restore the latest
backup from SharePoint:

```
"C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" -U postgres -d eams --no-owner --clean --if-exists "PATH-TO-LATEST\eams-XXXX.backup"
```
