export function nextOutboxAttempt(now: Date, attempt: number): Date {
	const minutes = attempt >= 6 ? 60 : Math.min(2 ** attempt, 30);
	return new Date(now.getTime() + minutes * 60_000);
}
