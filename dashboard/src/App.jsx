import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import './App.css'

function App() {
  const [stats, setStats] = useState(null)
  const [selectedMetric, setSelectedMetric] = useState(null)
  const [selectedTable, setSelectedTable] = useState(null)
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

  // Table 1: Weekly Research Stats order
  const researchStatsOrder = [
    "Research Requests submitted - Analysts",
    "Reports created - Analysts",
    "TOTAL RESEARCH REQUESTS submitted",
    "TOTAL REPORTS created",
    "PERSONALITY completed",
    "DIGITAL ANALYSIS completed",
    "DIGITAL INTELLIGENCE completed",
    "MAPIT delivered",
    "INSIGHTS delivered",
    "INFOGRAPHICS delivered",
    "PRESENTATIONS delivered",
    "SNAPSHOTS delivered",
    "RESOURCES delivered",
    "Sent to Design",
  ]

  // Table 2: Deliverables columns order
  const deliverablesOrder = [
    "Personality prep",
    "Digital Allocation",
    "Map (A)",
    "Map Total",
    "Research by Analysts (Average minutes)",
  ]

  // Table 3: Analyst names (sorted alphabetically)
  const analystNames = Object.keys(stats.analystStats || {}).sort()

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

  const getChartData = (data) => {
    return stats.weeks.map((week, idx) => ({
      week: week.split(' - ')[0],
      value: data.weekly ? data.weekly[idx] : data.reportsCompleted[idx]
    }))
  }

  const handleRowClick = (metric, table) => {
    if (selectedMetric === metric && selectedTable === table) {
      setSelectedMetric(null)
      setSelectedTable(null)
    } else {
      setSelectedMetric(metric)
      setSelectedTable(table)
    }
  }

  const getSelectedData = () => {
    if (!selectedMetric || !selectedTable) return null
    if (selectedTable === 'research') {
      return stats.researchStats[selectedMetric]
    } else if (selectedTable === 'total') {
      return stats.deliverables.total[selectedMetric]
    } else if (selectedTable === 'hours') {
      return stats.deliverables.hours[selectedMetric]
    } else if (selectedTable === 'analyst') {
      return stats.analystStats[selectedMetric]
    }
    return null
  }

  const selectedData = getSelectedData()

  return (
    <div className="app">
      <header>
        <h1>TopLine Weekly Dashboard</h1>
        <p className="generated">
          Last updated: {new Date(stats.generatedAt).toLocaleString()}
        </p>
      </header>

      <main>
        {/* Table 1: Weekly Research Stats */}
        <section className="table-section">
          <h2>Weekly Research Stats</h2>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th className="category-col">Metric</th>
                  {stats.weeks.map((week, idx) => (
                    <th key={idx} className="data-col">{week}</th>
                  ))}
                  <th className="data-col avg-col">4-Week Avg</th>
                  <th className="data-col wow-col">WoW</th>
                </tr>
              </thead>
              <tbody>
                {researchStatsOrder.map(metric => {
                  const data = stats.researchStats[metric]
                  if (!data) return null
                  const isSelected = selectedMetric === metric && selectedTable === 'research'
                  const isTotal = metric.startsWith('TOTAL')

                  return (
                    <tr
                      key={metric}
                      className={`${isTotal ? 'total-row' : ''} ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleRowClick(metric, 'research')}
                    >
                      <td className="category-col">{metric}</td>
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
        </section>

        {/* Table 2: Deliverables and Total Hours */}
        <section className="table-section">
          <h2>Deliverables and Total Hours</h2>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th className="category-col">Deliverable</th>
                  <th className="type-col">Type</th>
                  {stats.weeks.map((week, idx) => (
                    <th key={idx} className="data-col">{week}</th>
                  ))}
                  <th className="data-col avg-col">4-Week Avg</th>
                  <th className="data-col wow-col">WoW</th>
                </tr>
              </thead>
              <tbody>
                {deliverablesOrder.flatMap(col => {
                  const totalData = stats.deliverables.total[col]
                  const hoursData = stats.deliverables.hours[col]
                  if (!totalData || !hoursData) return []

                  const isTotalSelected = selectedMetric === col && selectedTable === 'total'
                  const isHoursSelected = selectedMetric === col && selectedTable === 'hours'

                  return [
                    <tr
                      key={`${col}-total`}
                      className={`deliverable-first ${isTotalSelected ? 'selected' : ''}`}
                      onClick={() => handleRowClick(col, 'total')}
                    >
                      <td className="category-col">{col}</td>
                      <td className="type-col">Total</td>
                      {totalData.weekly.map((val, idx) => (
                        <td key={idx} className="data-col">{val.toLocaleString()}</td>
                      ))}
                      <td className="data-col avg-col">{totalData.fourWeekAvg.toLocaleString()}</td>
                      <td className={`data-col wow-col ${getWoWClass(totalData.weekOverWeek)}`}>
                        {formatWoW(totalData.weekOverWeek)}
                      </td>
                    </tr>,
                    <tr
                      key={`${col}-hours`}
                      className={`deliverable-second hours-row ${isHoursSelected ? 'selected' : ''}`}
                      onClick={() => handleRowClick(col, 'hours')}
                    >
                      <td className="category-col">{col}</td>
                      <td className="type-col">Hours</td>
                      {hoursData.weekly.map((val, idx) => (
                        <td key={idx} className="data-col">{val}</td>
                      ))}
                      <td className="data-col avg-col">{hoursData.fourWeekAvg}</td>
                      <td className={`data-col wow-col ${getWoWClass(hoursData.weekOverWeek)}`}>
                        {formatWoW(hoursData.weekOverWeek)}
                      </td>
                    </tr>
                  ]
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Table 3: Research Team Output */}
        <section className="table-section">
          <h2>Research Team Output</h2>
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th className="category-col analyst-col">Analyst</th>
                  {stats.weeks.map((week, idx) => (
                    <th key={idx} className="data-col" colSpan={2}>{week}</th>
                  ))}
                  <th className="data-col avg-col">4-Week Avg</th>
                  <th className="data-col wow-col">WoW</th>
                </tr>
                <tr className="subheader">
                  <th></th>
                  {stats.weeks.map((_, idx) => (
                    [
                      <th key={`${idx}-reports`} className="data-col subhead">Reports</th>,
                      <th key={`${idx}-pct`} className="data-col subhead">% Total</th>
                    ]
                  )).flat()}
                  <th className="data-col avg-col subhead">Reports</th>
                  <th className="data-col wow-col subhead">Reports</th>
                </tr>
              </thead>
              <tbody>
                {analystNames.map(name => {
                  const data = stats.analystStats[name]
                  if (!data) return null
                  const isSelected = selectedMetric === name && selectedTable === 'analyst'

                  return (
                    <tr
                      key={name}
                      className={isSelected ? 'selected' : ''}
                      onClick={() => handleRowClick(name, 'analyst')}
                    >
                      <td className="category-col analyst-col">{name}</td>
                      {data.reportsCompleted.map((val, idx) => (
                        [
                          <td key={`${idx}-reports`} className="data-col">{val}</td>,
                          <td key={`${idx}-pct`} className="data-col pct-col">{data.pctOfTotal[idx]}%</td>
                        ]
                      )).flat()}
                      <td className="data-col avg-col">{data.fourWeekAvg}</td>
                      <td className={`data-col wow-col ${getWoWClass(data.weekOverWeek)}`}>
                        {formatWoW(data.weekOverWeek)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        {selectedData && (
          <div className="chart-container">
            <h2>
              {selectedMetric}
              {selectedTable === 'hours' ? ' (Hours)' : ''}
              {selectedTable === 'total' ? ' (Total)' : ''}
              {selectedTable === 'analyst' ? ' - Reports Completed' : ''}
            </h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={getChartData(selectedData)} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="week" />
                <YAxis />
                <Tooltip
                  formatter={(value) => [value.toLocaleString(), selectedTable === 'hours' ? 'Hours' : selectedTable === 'analyst' ? 'Reports' : 'Count']}
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
