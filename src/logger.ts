const PREFIX = "[hebrew-subtitles]";

export function info(message: string, data?: unknown) {
  if (data !== undefined) {
    console.log(`${PREFIX} ${message}`, data);
  } else {
    console.log(`${PREFIX} ${message}`);
  }
}

export function warn(message: string, data?: unknown) {
  if (data !== undefined) {
    console.warn(`${PREFIX} ${message}`, data);
  } else {
    console.warn(`${PREFIX} ${message}`);
  }
}

export function error(message: string, data?: unknown) {
  if (data !== undefined) {
    console.error(`${PREFIX} ${message}`, data);
  } else {
    console.error(`${PREFIX} ${message}`);
  }
}
