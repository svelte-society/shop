import {
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	type S3ClientConfig
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createS3BackupStore, S3BackupStore, type S3CommandSender } from './s3.server';

function sender(responses: unknown[] = []): S3CommandSender & { send: ReturnType<typeof vi.fn> } {
	return {
		send: vi.fn(async () => responses.shift() ?? {})
	};
}

describe('S3BackupStore', () => {
	it('configures the exact endpoint, region, credentials, and path-style mode', async () => {
		let captured: S3ClientConfig | undefined;
		const client = sender();
		const store = createS3BackupStore(
			{
				endpoint: 'https://s3.eu.example.test',
				region: 'eu-north-1',
				bucket: 'shop-backups',
				accessKeyId: 'access-id',
				secretAccessKey: 'private-secret',
				forcePathStyle: true
			},
			{
				createClient(configuration) {
					captured = configuration;
					return client;
				}
			}
		);

		await store.list('daily/');

		expect(captured).toMatchObject({
			endpoint: 'https://s3.eu.example.test',
			region: 'eu-north-1',
			forcePathStyle: true,
			credentials: { accessKeyId: 'access-id', secretAccessKey: 'private-secret' }
		});
	});

	it.each([
		'http://s3.example.test',
		' https://s3.example.test',
		'https://user:secret@s3.example.test',
		'https://s3.example.test/?token=secret'
	])('rejects an unsafe endpoint before constructing a credentialed client', (endpoint) => {
		const createClient = vi.fn();

		expect(() =>
			createS3BackupStore(
				{
					endpoint,
					region: 'eu-north-1',
					bucket: 'shop-backups',
					accessKeyId: 'access-id',
					secretAccessKey: 'private-secret',
					forcePathStyle: false
				},
				{ createClient }
			)
		).toThrowError(/^BACKUP_STORE_CONFIG_INVALID$/);
		expect(createClient).not.toHaveBeenCalled();
	});

	it('uploads encrypted and checksum companions with exact commands and abort signal', async () => {
		const client = sender();
		const store = new S3BackupStore('shop-backups', client);
		const encrypted = Uint8Array.from([0x53, 0x53, 0x42, 0x4b, 0x31]);
		const checksum = Buffer.from(`${'a'.repeat(64)}\n`);
		const controller = new AbortController();

		await store.put(
			'daily/shop.sqlite.ssbk',
			encrypted,
			'application/octet-stream',
			controller.signal
		);
		await store.put(
			'daily/shop.sqlite.ssbk.sha256',
			checksum,
			'text/plain; charset=utf-8',
			controller.signal
		);

		const first = client.send.mock.calls[0];
		const second = client.send.mock.calls[1];
		expect(first[0]).toBeInstanceOf(PutObjectCommand);
		expect(first[0].input).toEqual({
			Bucket: 'shop-backups',
			Key: 'daily/shop.sqlite.ssbk',
			Body: encrypted,
			ContentType: 'application/octet-stream'
		});
		expect(second[0]).toBeInstanceOf(PutObjectCommand);
		expect(second[0].input).toEqual({
			Bucket: 'shop-backups',
			Key: 'daily/shop.sqlite.ssbk.sha256',
			Body: checksum,
			ContentType: 'text/plain; charset=utf-8'
		});
		expect(first[1]).toEqual({ abortSignal: controller.signal });
		expect(second[1]).toEqual({ abortSignal: controller.signal });
	});

	it('downloads an object body as bytes', async () => {
		const bytes = Uint8Array.from([1, 2, 3, 4]);
		const client = sender([{ Body: { transformToByteArray: async () => bytes } }]);
		const store = new S3BackupStore('shop-backups', client);

		await expect(store.get('daily/object.ssbk')).resolves.toEqual(bytes);

		const command = client.send.mock.calls[0][0];
		expect(command).toBeInstanceOf(GetObjectCommand);
		expect(command.input).toEqual({ Bucket: 'shop-backups', Key: 'daily/object.ssbk' });
	});

	it('paginates listings until the continuation token is exhausted', async () => {
		const firstDate = new Date('2026-06-01T02:30:00.000Z');
		const secondDate = new Date('2026-07-01T02:30:00.000Z');
		const client = sender([
			{
				Contents: [{ Key: 'daily/old.ssbk', LastModified: firstDate }],
				IsTruncated: true,
				NextContinuationToken: 'private-continuation-token'
			},
			{
				Contents: [{ Key: 'daily/new.ssbk', LastModified: secondDate }],
				IsTruncated: false
			}
		]);
		const store = new S3BackupStore('shop-backups', client);

		await expect(store.list('daily/')).resolves.toEqual([
			{ key: 'daily/old.ssbk', lastModified: firstDate },
			{ key: 'daily/new.ssbk', lastModified: secondDate }
		]);

		expect(client.send).toHaveBeenCalledTimes(2);
		const first = client.send.mock.calls[0][0];
		const second = client.send.mock.calls[1][0];
		expect(first).toBeInstanceOf(ListObjectsV2Command);
		expect(first.input).toEqual({ Bucket: 'shop-backups', Prefix: 'daily/' });
		expect(second.input).toEqual({
			Bucket: 'shop-backups',
			Prefix: 'daily/',
			ContinuationToken: 'private-continuation-token'
		});
	});

	it('deletes object keys in S3 batches including encrypted/checksum pairs', async () => {
		const client = sender([{}, {}]);
		const store = new S3BackupStore('shop-backups', client);
		const keys = [
			'old/shop.sqlite.ssbk',
			'old/shop.sqlite.ssbk.sha256',
			...Array.from({ length: 999 }, (_, index) => `old/${index}.ssbk`)
		];

		await store.delete(keys);

		expect(client.send).toHaveBeenCalledTimes(2);
		const first = client.send.mock.calls[0][0];
		const second = client.send.mock.calls[1][0];
		expect(first).toBeInstanceOf(DeleteObjectsCommand);
		expect(first.input.Delete.Objects).toHaveLength(1_000);
		expect(first.input.Delete.Objects.slice(0, 2)).toEqual([
			{ Key: 'old/shop.sqlite.ssbk' },
			{ Key: 'old/shop.sqlite.ssbk.sha256' }
		]);
		expect(first.input.Delete.Quiet).toBe(true);
		expect(second.input.Delete.Objects).toHaveLength(1);
	});

	it.each(['put', 'get', 'list', 'delete'] as const)(
		'redacts provider details from a failed %s',
		async (operation) => {
			const privateMessage = 'private-secret object-body customer@example.test';
			const client: S3CommandSender = {
				send: vi.fn(async () => {
					throw new Error(privateMessage);
				})
			};
			const store = new S3BackupStore('shop-backups', client);
			const call =
				operation === 'put'
					? store.put('key', Uint8Array.from([1]), 'application/octet-stream')
					: operation === 'get'
						? store.get('key')
						: operation === 'list'
							? store.list('prefix')
							: store.delete(['key']);

			await expect(call).rejects.toThrowError(/^BACKUP_STORE_FAILED$/);
			await expect(call).rejects.not.toThrow(privateMessage);
		}
	);
});
