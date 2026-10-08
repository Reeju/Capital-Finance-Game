// Recharts is loaded lazily (it is the largest dependency); every chart has a table twin for screen readers.
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usdShort } from './format';

export interface Series { key: string; name: string; color: string; dashed?: boolean }
export default function TrendChart({ data, series, label }: { data: Record<string, number>[]; series: Series[]; label: string }) {
  return (
    <div role="img" aria-label={label} style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#2c3b57" strokeDasharray="3 3" />
          <XAxis dataKey="round" stroke="#a9b6cc" tickLine={false} />
          <YAxis stroke="#a9b6cc" tickFormatter={(v: number) => usdShort(v)} width={62} tickLine={false} />
          <Tooltip formatter={(v) => usdShort(Number(v))} labelFormatter={(l) => `Year ${l}`} contentStyle={{ background: '#172133', border: '1px solid #2c3b57', borderRadius: 10 }} />
          <Legend />
          {series.map((s) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.5} strokeDasharray={s.dashed ? '6 4' : undefined} dot={false} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
