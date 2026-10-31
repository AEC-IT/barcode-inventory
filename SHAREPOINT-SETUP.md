# Store photos in SharePoint

Once this is set up, every asset and bill photo is saved to SharePoint and the
database keeps only a link. Photos already in the database are moved over
automatically in the background after the next deploy. Nothing changes for
staff: photos show in the app exactly as before, and they don't need
SharePoint accounts.

Needs someone with **Microsoft 365 admin** rights (Global Admin, or Application
Admin plus SharePoint Admin). About 15 minutes. No extra cost.

## 1. Create a SharePoint site for the photos

1. Go to SharePoint (`https://<yourcompany>.sharepoint.com`), then **+ Create site → Team site**.
2. Name it, for example, **Asset Photos**. Make it **Private**.
3. Copy the site's address from the browser, for example
   `https://aecgroup.sharepoint.com/sites/AssetPhotos`. This is `SHAREPOINT_SITE`.

## 2. Register the app

1. Go to **https://entra.microsoft.com → App registrations → New registration**.
2. **Name:** `AEC Barcode Inventory`. **Supported account types:** *this organization only*. Leave Redirect URI empty. Click **Register**.
3. On the app's **Overview** page, copy:
   - **Directory (tenant) ID**: this is `MS_TENANT_ID`.
   - **Application (client) ID**: this is `MS_CLIENT_ID`.
4. Go to **Certificates & secrets → New client secret**, set it to expire in 24 months, and click **Add**.
   Copy the **Value** right away (it's only shown once). This is `MS_CLIENT_SECRET`.
   Set a calendar reminder to renew it before it expires, or photo uploads will fall back to the database.

## 3. Give the app permission

**Simple option (recommended for a small company):**

1. In the app, open **API permissions → Add a permission → Microsoft Graph → Application permissions**.
2. Tick **Files.ReadWrite.All** and click **Add permissions**.
3. Click **Grant admin consent for <your org>** and confirm. The status should turn green.

This lets the app read and write files across the company's SharePoint and OneDrive. If that's
too broad, use the locked-down option instead.

**Locked-down option (this one site only):** add **Sites.Selected** instead of Files.ReadWrite.All,
grant admin consent, then have an admin grant the app `write` access to just the Asset Photos site
(Graph: `POST /sites/{site-id}/permissions` with `roles: ["write"]` and the app's client ID, or the
PnP PowerShell `Grant-PnPAzureADAppSitePermission` command).

## 4. Add the values to Render

On Render, open **barcode-inventory → Environment** and add:

| Key | Value |
| --- | --- |
| `MS_TENANT_ID` | Directory (tenant) ID from step 2 |
| `MS_CLIENT_ID` | Application (client) ID from step 2 |
| `MS_CLIENT_SECRET` | Secret **Value** from step 2 |
| `SHAREPOINT_SITE` | Site address from step 1 |

Click **Save, rebuild, and deploy**.

## 5. Check it worked

- Take a photo of an asset in the scanner app. It should appear in the app as normal, and in
  SharePoint under **Documents → Barcode Inventory → <business> → Assets → <month>**.
- About 15 seconds after startup, the Render logs show
  `Photo migration to SharePoint: N moved, 0 failed`.

If uploads fail (wrong secret, missing consent), the app **keeps working**: photos are saved to the
database as before, the error is in the Render logs, and they're moved over automatically on a later
restart once it's fixed.

## Limits

- **Storage:** SharePoint storage is shared across the company: 1 TB plus 10 GB per licensed user.
  Compressed photos are about 50–250 KB, so 100,000 photos use roughly 10–20 GB.
- **File size:** photos are capped at 3 MB by the app (SharePoint allows up to 250 GB per file).
- Deleting an asset doesn't delete its photo from SharePoint, so the file is kept as a record.
