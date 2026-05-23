# Oracle Always Free Argos Translate Backend

This backend is designed to run on an Oracle Cloud Always Free compute instance or any small VM that can install Python and host a local HTTP service.

## What it provides

- A FastAPI service with a background translation queue.
- A `GET /manifest.json` endpoint for the Stremio add-on manifest.
- A `GET /subtitles/{imdb_id}` endpoint for subtitle discovery and delivery.
- Oracle-managed KV storage for original and translated subtitle text.

## Deployment steps

1. Create an Oracle Always Free compute instance.
2. Install Python 3.12 and Git.
3. Clone or copy this repository into the instance.
4. Install dependencies:

```bash
cd /path/to/stremio-hebrew-subtitles/backend
python -m pip install --upgrade pip
pip install -r requirements.txt
```

5. Create an Oracle NoSQL table for KV storage.

Use OCI Console or CLI to create a table such as:

```sql
CREATE TABLE subtitle_cache (
  key STRING,
  value CLOB,
  updated_at TIMESTAMP(6)
)
PRIMARY KEY (key);
```

6. Set environment variables in the VM:

```bash
export OCI_KV_TABLE_ID="ocid1.nosqltable.oc1..example"
export OPENSUBTITLES_API_KEY="your-opensubtitles-api-key"
export ARGOS_SOURCE_LANG="en"
export ARGOS_TARGET_LANG="he"
```

If the instance is configured with instance principals, no additional OCI config file is required. Otherwise set:

```bash
export OCI_CONFIG_FILE="/home/opc/.oci/config"
export OCI_CONFIG_PROFILE="DEFAULT"
```

7. Install the Argos Translate English-to-Hebrew model package.

You can download the package locally and install it with:

```bash
python -m argostranslate.package install_from_path /path/to/translate_en_he.argosmodel
```

If you already have the model downloaded on the instance, place it somewhere accessible and use the same command.

6. Start the server:

```bash
uvicorn app:app --host 0.0.0.0 --port 8080
```

## API example

Get the manifest:

```bash
curl http://YOUR_VM:8080/manifest.json
```

Request subtitles for an IMDb ID and filename:

```bash
curl "http://YOUR_VM:8080/subtitles/tt26443616?filename=Hoppers.2026.1080p.WEBRip.10Bit.DDP.5.1.x265-NeoNoir.mkv.json"
```

If translation is not yet ready, the response will queue the job and return an empty `subtitles` array. Once the backend has completed translation, retry the same request to receive the translated subtitles.

## Notes

- The first request queues the translation in the background. Subsequent requests for the same IMDb ID and filename will return the translated subtitles once ready.
- The backend stores subtitle cache data in Oracle NoSQL KV using keys like:
  - `sub:<imdbId>-<filename>-original`
  - `sub:<imdbId>-<filename>-translation`
- The full filename is preserved in the cache key to avoid collisions when multiple subtitle filenames exist for the same movie.
