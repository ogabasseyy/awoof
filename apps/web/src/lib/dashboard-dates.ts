type DailyPoint = { date: string; orders: number; completedOrders?: number; revenue: number };

// Matches the API's UTC calendar dates, independent of browser timezone.
export function sevenDaySeries(points: DailyPoint[], now = new Date()) {
    const byDay = new Map(points.map((point) => [point.date.slice(0, 10), point]));
    return Array.from({ length: 7 }, (_, index) => {
        const day = new Date(now);
        day.setUTCHours(0, 0, 0, 0);
        day.setUTCDate(day.getUTCDate() - 6 + index);
        const key = day.toISOString().slice(0, 10);
        const point = byDay.get(key);
        return {
            key,
            label: day.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }),
            orders: point?.completedOrders ?? point?.orders ?? 0,
            revenue: point?.revenue ?? 0,
        };
    });
}
