import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import './App.css'

function App() {
  const [stats, setStats] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch('/data/topline-stats.json')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load data')
        return res.json()
      })
      .then(data => {
        setStats(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  if (loading) return <div className="loading">Loading...</div>
  if (error) return <div className="error">Error: {error}</div>
  if (!stats) return <div className="error">No data available</div>

  const categoryOrder = [
    'PERSONALITY',
    'DIGITAL ANALYSIS',
    'DIGITAL INTELLIGENCE',
    'MAPIT',
    'INSIGHTS',
    'INFOGRAPHICS',
    'PRESENTATIONS',
    'SNAPSHOTS',
    'RESOURCES',
    'TOTAL SENT TO DESIGN'
  ]

  const formatWoW = (value) => {
    if (value === null) return '—'
    const sign = value >= 0 ? '+' : ''
    return `${sign}${value}%`
  }

  const getWoWClass = (value) => {
    if (value === null) return ''
    if (value > 0) return 'positive'
    if (value < 0) return 'negative'
    return ''
  }

  const getChartData = (category) => {
    const data = stats.categories[category]
    return stats.weeks.map((week, idx) => ({
      week: week.split(' - ')[0],
      value: data.weekly[idx]
    }))
  }

  return (
    <div className="app">
      <header>
        <h1>TopLine Status Dashboard</h1>
        <p className="generated">
          Last updated: {new Date(stats.generatedAt).toLocaleString()}
        </p>
      </header>

      <main>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th className="category-col">Deliverable</th>
                {stats.weeks.map((week, idx) => (
                  <th key={idx} className="data-col">{week}</th>
                ))}
                <th className="data-col avg-col">4-Week Avg</th>
                <th className="data-col wow-col">WoW</th>
              </tr>
            </thead>
            <tbody>
              {categoryOrder.map(category => {
                const data = stats.categories[category]
                if (!data) return null
                const isTotal = category === 'TOTAL SENT TO DESIGN'
                const isSelected = selectedCategory === category

                return (
                  <tr
                    key={category}
                    className={`${isTotal ? 'total-row' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedCategory(isSelected ? null : category)}
                  >
                    <td className="category-col">{category}</td>
                    {data.weekly.map((val, idx) => (
                      <td key={idx} className="data-col">{val.toLocaleString()}</td>
                    ))}
                    <td className="data-col avg-col">{data.fourWeekAvg.toLocaleString()}</td>
                    <td className={`data-col wow-col ${getWoWClass(data.weekOverWeek)}`}>
                      {formatWoW(data.weekOverWeek)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {selectedCategory && (
          <div className="chart-container">
            <h2>{selectedCategory}</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={getChartData(selectedCategory)} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="week" />
                <YAxis />
                <Tooltip
                  formatter={(value) => [value.toLocaleString(), 'Count']}
                  labelFormatter={(label) => `Week of ${label}`}
                />
                <Bar dataKey="value" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </main>

      <footer>
        <p>Click any row to view chart</p>
      </footer>
    </div>
  )
}

export default App
