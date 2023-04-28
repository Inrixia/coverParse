import { mkdir, readFile, writeFile } from "fs/promises";
import got from "got";
import { promisify } from "util";
import { createHash } from "crypto";

const sleep = promisify(setTimeout);

type Entry = {
	id: number;
	cover: string;
	coverPath?: string;
	chapter_urls: string[];
	chapter_paths?: string[];
};

const outDir = "./images";

class Downloader {
	// The number of available slots for making delivery requests,
	// limiting the rate of requests to avoid exceeding the API rate limit.
	private avalibleDeliverySlots;
	private downloadQueue: (() => void)[] = [];
	private static MaxRetries = 5;

	constructor(downloadThreads: number) {
		this.avalibleDeliverySlots = downloadThreads;
	}

	private async getDownloadSempahore() {
		// If there is an available request slot, proceed immediately
		if (this.avalibleDeliverySlots > 0) return this.avalibleDeliverySlots--;

		// Otherwise, wait for a request slot to become available
		return new Promise((r) => this.downloadQueue.push(() => r(this.avalibleDeliverySlots--)));
	}

	private releaseDownloadSemaphore() {
		this.avalibleDeliverySlots++;

		// If there are queued requests, resolve the first one in the queue
		this.downloadQueue.shift()?.();
	}

	private async doDownload(url: URL, throwHttpErrors = true, retries = 0, retryDelay = 1000): Promise<string> {
		try {
			const response = await got(url, {
				responseType: "buffer",
				resolveBodyOnly: false,
				https: { rejectUnauthorized: false },
				throwHttpErrors,
			});

			const mediaTypes = ["audio", "image", "video"];

			if (
				response.headers["content-type"] !== undefined &&
				(!mediaTypes.some((type) => response.headers["content-type"]!.toLowerCase().includes(type)) || response.headers["content-type"].toLowerCase().includes("charset"))
			) {
				if (!throwHttpErrors) throw new Error(`Invalid content-type ${response.headers["content-type"]}`);
				return `Invalid content-type ${response.headers["content-type"]}`;
			}

			const fileName = md5Hash(response.body);
			const fileExt = response.headers["content-type"] !== undefined ? removeBefore(response.headers["content-type"], "/") : "";
			const filePath = `${outDir}/${fileName}.${fileExt}`;

			await writeFile(filePath, response.body);

			return filePath;
		} catch (err: any) {
			switch (err.message) {
				case "Response code 400 (Bad Request)":
				case "Response code 404 (Not Found)":
				case "Response code 403 (Forbidden)":
				case "Response code 503 (Service Unavailable)":
				case "Response code 410 (Gone)":
				case "Response code 422 (Unknown)":
					return err.message;
			}

			if (err.message.includes("getaddrinfo ENOTFOUND")) return err.message;

			if (retries < Downloader.MaxRetries) {
				await sleep(retryDelay);
				return this.doDownload(url, throwHttpErrors, retries + 1, retryDelay + 1000);
			} else return err.message;
		}
	}

	public async download(url: URL, retryErrors?: boolean): Promise<string> {
		await this.getDownloadSempahore();

		const result = await this.doDownload(url, retryErrors);

		this.releaseDownloadSemaphore();

		return result;
	}
}

const md5Hash = (str: Buffer) => {
	const hash = createHash("md5");
	hash.update(str);
	return hash.digest("hex");
};

const removeBefore = (s: string, del: string) => s.substring(s.indexOf(del) + 1, s.length);

(async () => {
	await mkdir(outDir, { recursive: true });

	const imgs: Entry[] = JSON.parse((await readFile("./images.json")).toString());

	const urlSet = new Set<string>();
	for (const entry of imgs) {
		urlSet.add(entry.cover);
		entry.chapter_urls.map((url) => urlSet.add(url));
	}

	urlSet.delete(null!);
	const urlArray = Array.from(urlSet);

	const imgMap: Record<string, string> = {};

	for (const url of urlArray) {
		const u = new URL(url);
		const qUrl = u.searchParams.get("url");
		let fUrl = qUrl ?? url;

		if (fUrl.startsWith("//")) fUrl = fUrl.slice(2, fUrl.length);

		imgMap[url] = fUrl;
	}

	// await writeFile("./rawImagesMap.json", JSON.stringify(imgMap));

	const urlPathMap: Record<string, string> = JSON.parse((await readFile("./urlPathMap.json")).toString());

	const todo = Object.entries(imgMap).sort(() => Math.random() - 0.5);

	const downloaders: Record<string, Downloader> = {};

	let saveInterval = false;
	const saveJson = async () => {
		await writeFile("./urlPathMap.json", JSON.stringify(urlPathMap));

		for (const entry of imgs) {
			entry.coverPath = urlPathMap[entry.cover];
			entry.chapter_paths = entry.chapter_urls.map((url) => urlPathMap[url]);
		}

		await writeFile("./imagePaths.json", JSON.stringify(imgs));

		if (saveInterval) return;
		setTimeout(saveJson, 60000);
	};
	setTimeout(saveJson, 60000);

	downloaders.retry = new Downloader(128);

	await saveJson();

	let done = 0;
	await Promise.all(
		todo.map(async ([k, url]) => {
			if (urlPathMap[k] !== undefined) {
				process.stdout.write(`\r${++done}/${todo.length}`);
				return;
			}
			const kUrl = new URL(k);
			let downUrl;
			try {
				downUrl = new URL(url);
			} catch (err) {
				downUrl = kUrl;
			}

			downloaders[downUrl.hostname] ??= new Downloader(128);

			if (k === url) {
				urlPathMap[k] = await downloaders[downUrl.hostname].download(downUrl, false);
			} else {
				urlPathMap[k] = await downloaders[downUrl.hostname].download(downUrl);
				if (!urlPathMap[k].includes(outDir) && k !== url) {
					urlPathMap[k] = await downloaders.retry.download(kUrl, false);
				}
			}

			process.stdout.write(`\r${++done}/${todo.length}`);
		})
	);

	saveInterval = true;
	await saveJson();
})();
