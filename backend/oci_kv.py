import json
import logging
import os
from typing import Optional

import oci
from oci.config import from_file
from oci.nosql import NosqlClient

logger = logging.getLogger("argos_subtitles.oci_kv")


class OracleKvClient:
    def __init__(self):
        self.table_id = os.getenv("OCI_KV_TABLE_ID")
        if not self.table_id:
            raise RuntimeError("OCI_KV_TABLE_ID environment variable is required")

        config_path = os.getenv("OCI_CONFIG_FILE")
        config_profile = os.getenv("OCI_CONFIG_PROFILE", "DEFAULT")
        self._signer = None
        self._config = None

        if config_path and os.path.exists(config_path):
            self._config = from_file(file_location=config_path, profile_name=config_profile)
            logger.info("Loaded OCI config file", {"config_file": config_path, "profile": config_profile})
        else:
            self._signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
            logger.info("Using OCI instance principals signer")

        self.client = NosqlClient(config=self._config, signer=self._signer)
        logger.info("Initialized Oracle NoSQL client", {"table_id": self.table_id})

    def get_string(self, key: str) -> Optional[str]:
        logger.debug("Retrieving KV value", {"key": key})
        try:
            row = self.client.get_row(table_name_or_id=self.table_id, key={"key": key})
            return row.data.get("value")
        except Exception as exc:
            if hasattr(exc, "status") and exc.status == 404:
                return None
            logger.error("OCI KV get_row failed", exc_info=exc, extra={"key": key})
            raise

    def put_string(self, key: str, value: str) -> None:
        logger.debug("Storing KV value", {"key": key, "length": len(value)})
        row = {"key": key, "value": value}
        self.client.put_row(table_name_or_id=self.table_id, row=row)

    def put_json(self, key: str, data: dict) -> None:
        self.put_string(key, json.dumps(data, ensure_ascii=False))

    def get_json(self, key: str) -> Optional[dict]:
        raw = self.get_string(key)
        if raw is None:
            return None
        return json.loads(raw)

    def delete_key(self, key: str) -> None:
        logger.debug("Deleting KV key", {"key": key})
        self.client.delete_row(table_name_or_id=self.table_id, key={"key": key})
