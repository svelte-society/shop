import {
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig
} from '@aws-sdk/client-s3';

export interface BackupStore {
	put(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>;
	get(key: string, signal?: AbortSignal): Promise<Uint8Array>;
	list(prefix: string, signal?: AbortSignal): Promise<Array<{ key: string; lastModified: Date }>>;
	delete(keys: string[], signal?: AbortSignal): Promise<void>;
}

export interface S3CommandSender {
	send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export type S3BackupStoreOptions = {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
};

export type S3BackupStoreDependencies = {
	createClient?: (configuration: S3ClientConfig) => S3CommandSender;
};

type ListResponse = {
	Contents?: Array<{ Key?: string; LastModified?: Date }>;
	IsTruncated?: boolean;
	NextContinuationToken?: string;
};

type GetResponse = {
	Body?: { transformToByteArray?: () => Promise<Uint8Array> };
};

type DeleteResponse = {
	Errors?: unknown[];
};

function exactNonEmpty(value: string): boolean {
	return value.length > 0 && value === value.trim() && !/[\r\n]/u.test(value);
}

function safeEndpoint(value: string): boolean {
	if (!exactNonEmpty(value)) return false;
	try {
		const endpoint = new URL(value);
		return (
			endpoint.protocol === 'https:' &&
			!endpoint.username &&
			!endpoint.password &&
			!endpoint.search &&
			!endpoint.hash
		);
	} catch {
		return false;
	}
}

export function s3BackupStoreOptionsAreValid(options: S3BackupStoreOptions): boolean {
	return (
		safeEndpoint(options.endpoint) &&
		exactNonEmpty(options.region) &&
		exactNonEmpty(options.bucket) &&
		exactNonEmpty(options.accessKeyId) &&
		exactNonEmpty(options.secretAccessKey) &&
		typeof options.forcePathStyle === 'boolean'
	);
}

export class S3BackupStore implements BackupStore {
	constructor(
		private readonly bucket: string,
		private readonly client: S3CommandSender
	) {}

	async put(
		key: string,
		body: Uint8Array,
		contentType: string,
		signal?: AbortSignal
	): Promise<void> {
		try {
			await this.client.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: key,
					Body: body,
					ContentType: contentType
				}),
				{ abortSignal: signal }
			);
		} catch {
			throw new Error('BACKUP_STORE_FAILED');
		}
	}

	async get(key: string, signal?: AbortSignal): Promise<Uint8Array> {
		try {
			const response = (await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key }),
				{ abortSignal: signal }
			)) as GetResponse;
			if (!response.Body?.transformToByteArray) throw new Error('BACKUP_STORE_BODY_MISSING');
			return await response.Body.transformToByteArray();
		} catch {
			throw new Error('BACKUP_STORE_FAILED');
		}
	}

	async list(
		prefix: string,
		signal?: AbortSignal
	): Promise<Array<{ key: string; lastModified: Date }>> {
		const objects: Array<{ key: string; lastModified: Date }> = [];
		let continuationToken: string | undefined;
		try {
			do {
				const response = (await this.client.send(
					new ListObjectsV2Command({
						Bucket: this.bucket,
						Prefix: prefix,
						...(continuationToken ? { ContinuationToken: continuationToken } : {})
					}),
					{ abortSignal: signal }
				)) as ListResponse;
				for (const object of response.Contents ?? []) {
					if (object.Key && object.LastModified) {
						objects.push({ key: object.Key, lastModified: object.LastModified });
					}
				}
				if (!response.IsTruncated) break;
				if (!response.NextContinuationToken) throw new Error('BACKUP_STORE_PAGINATION_INVALID');
				continuationToken = response.NextContinuationToken;
			} while (continuationToken);
			return objects;
		} catch {
			throw new Error('BACKUP_STORE_FAILED');
		}
	}

	async delete(keys: string[], signal?: AbortSignal): Promise<void> {
		try {
			for (let offset = 0; offset < keys.length; offset += 1_000) {
				const batch = keys.slice(offset, offset + 1_000);
				const response = (await this.client.send(
					new DeleteObjectsCommand({
						Bucket: this.bucket,
						Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
					}),
					{ abortSignal: signal }
				)) as DeleteResponse;
				if ((response.Errors?.length ?? 0) > 0) throw new Error('BACKUP_STORE_DELETE_FAILED');
			}
		} catch {
			throw new Error('BACKUP_STORE_FAILED');
		}
	}
}

export function createS3BackupStore(
	options: S3BackupStoreOptions,
	dependencies: S3BackupStoreDependencies = {}
): BackupStore {
	if (!s3BackupStoreOptionsAreValid(options)) throw new Error('BACKUP_STORE_CONFIG_INVALID');
	const configuration: S3ClientConfig = {
		endpoint: options.endpoint,
		region: options.region,
		forcePathStyle: options.forcePathStyle,
		credentials: {
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey
		}
	};
	const client = dependencies.createClient
		? dependencies.createClient(configuration)
		: (new S3Client(configuration) as unknown as S3CommandSender);
	return new S3BackupStore(options.bucket, client);
}
