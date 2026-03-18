import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import './App.css'

function App() {
  const [stats, setStats] = useState(null)
  const [selectedMetric, setSelectedMetric] = useState(null)
  const [selectedTable, setSelectedTable] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('research')
  const [utilizationMode, setUtilizationMode] = useState('volume') // 'volume' or 'time'

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

  // Tab configuration
  const tabs = [
    { id: 'research', label: 'Weekly Research Stats' },
    { id: 'deliverables', label: 'Deliverables and Total Hours' },
    { id: 'utilization', label: 'Utilization by Analyst' },
    { id: 'team', label: 'Research Team Output' },
  ]

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

  // Utilization section: Radio and TV analysts (first names match Pull 2 data keys)
  // Note: Marina Nasonti (was Kestner)
  const radioAnalysts = ['Adam', 'Alison', 'Amanda', 'Anthony', 'Carly', 'Jenn', 'Jordan', 'Kyle', 'Marina', 'Steve']
  const tvAnalysts = ['Damaris', 'Hayley', 'Jeff', 'Marta', 'Meghan', 'Nicole', 'Rose']

  // Volume baselines
  const RADIO_BASELINE = { requests: 31, reports: 92 }
  const TV_BASELINE = { requests: 45, reports: 22 }

  // Get last 2 weeks indices (most recent and week before)
  const recentWeekIndices = [2, 3] // weeks[2] and weeks[3]

  // Calculate utilization metrics for an analyst (2 weeks only)
  const getUtilizationData = (name, team) => {
    const util = stats.utilization?.[name]
    if (!util) return null

    const baseline = team === 'radio' ? RADIO_BASELINE : TV_BASELINE

    // Calculate per-week metrics for all weeks
    const allWeeklyData = util.weekly.map(week => {
      const volumeUtil = (
        (week.totalRequests / baseline.requests) +
        (week.totalReports / baseline.reports)
      ) / 2 * 100

      const totalMinutes = (
        week.totalRequests * week.avgRequestTime +
        week.totalDesigns * week.avgDesignTime
      )
      const timeUtil = (totalMinutes / 2400) * 100

      return {
        ...week,
        volumeUtil,
        timeUtil
      }
    })

    // Get only last 2 weeks
    const weeklyData = recentWeekIndices.map(idx => allWeeklyData[idx])

    // Calculate 2-week averages
    const avgRequests = weeklyData.reduce((sum, w) => sum + w.totalRequests, 0) / 2
    const avgReports = weeklyData.reduce((sum, w) => sum + w.totalReports, 0) / 2
    const avgVolumeUtil = weeklyData.reduce((sum, w) => sum + w.volumeUtil, 0) / 2
    const avgTimeUtil = weeklyData.reduce((sum, w) => sum + w.timeUtil, 0) / 2

    // Calculate WoW
    const lastWeekUtil = utilizationMode === 'volume' ? weeklyData[1]?.volumeUtil : weeklyData[1]?.timeUtil
    const prevWeekUtil = utilizationMode === 'volume' ? weeklyData[0]?.volumeUtil : weeklyData[0]?.timeUtil
    const wow = prevWeekUtil > 0 ? Math.round(((lastWeekUtil - prevWeekUtil) / prevWeekUtil) * 100) : null

    return {
      name,
      fullName: util.fullName,
      weeklyData,
      avgRequests: Math.round(avgRequests * 10) / 10,
      avgReports: Math.round(avgReports * 10) / 10,
      avgVolumeUtil: Math.round(avgVolumeUtil * 10) / 10,
      avgTimeUtil: Math.round(avgTimeUtil * 10) / 10,
      wow
    }
  }

  // Calculate team averages for utilization (2 weeks only)
  const getTeamUtilizationAverage = (analysts, team) => {
    const validData = analysts
      .map(name => getUtilizationData(name, team))
      .filter(d => d !== null)

    if (validData.length === 0) return null

    const weeklyAvgs = [0, 1].map(weekIdx => {
      const weekData = validData.map(d => d.weeklyData[weekIdx])
      return {
        totalRequests: weekData.reduce((sum, w) => sum + w.totalRequests, 0) / validData.length,
        totalReports: weekData.reduce((sum, w) => sum + w.totalReports, 0) / validData.length,
        volumeUtil: weekData.reduce((sum, w) => sum + w.volumeUtil, 0) / validData.length,
        timeUtil: weekData.reduce((sum, w) => sum + w.timeUtil, 0) / validData.length
      }
    })

    return {
      weeklyData: weeklyAvgs,
      avgVolumeUtil: validData.reduce((sum, d) => sum + d.avgVolumeUtil, 0) / validData.length,
      avgTimeUtil: validData.reduce((sum, d) => sum + d.avgTimeUtil, 0) / validData.length,
      wow: null
    }
  }

  // Calculate totals for Research Team Output
  const getTeamTotals = () => {
    const totals = {
      reportsCompleted: stats.weeks.map(() => 0),
      totalMinutes: stats.weeks.map(() => 0),
      avgMinutes: stats.weeks.map(() => 0),
      fourWeekAvgReports: 0,
      fourWeekAvgMinutes: 0,
      wowReports: null,
      wowMinutes: null
    }

    analystNames.forEach(name => {
      const data = stats.analystStats[name]
      if (data) {
        data.reportsCompleted.forEach((val, idx) => {
          totals.reportsCompleted[idx] += val
          totals.totalMinutes[idx] += val * (data.avgMinutes[idx] || 0)
        })
      }
    })

    // Calculate avg minutes per report per week
    totals.avgMinutes = totals.reportsCompleted.map((reports, idx) =>
      reports > 0 ? Math.round(totals.totalMinutes[idx] / reports) : 0
    )

    // 4-week averages
    totals.fourWeekAvgReports = Math.round(totals.reportsCompleted.reduce((a, b) => a + b, 0) / 4)
    const totalAllMinutes = totals.totalMinutes.reduce((a, b) => a + b, 0)
    const totalAllReports = totals.reportsCompleted.reduce((a, b) => a + b, 0)
    totals.fourWeekAvgMinutes = totalAllReports > 0 ? Math.round(totalAllMinutes / totalAllReports) : 0

    // WoW for reports
    const lastWeekReports = totals.reportsCompleted[3]
    const prevWeekReports = totals.reportsCompleted[2]
    if (prevWeekReports > 0) {
      totals.wowReports = Math.round(((lastWeekReports - prevWeekReports) / prevWeekReports) * 100)
    }

    // WoW for avg minutes
    const lastWeekMinutes = totals.avgMinutes[3]
    const prevWeekMinutes = totals.avgMinutes[2]
    if (prevWeekMinutes > 0) {
      totals.wowMinutes = Math.round(((lastWeekMinutes - prevWeekMinutes) / prevWeekMinutes) * 100)
    }

    return totals
  }

  const teamTotals = getTeamTotals()

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

  // Get week labels for utilization (last 2 weeks)
  const utilizationWeeks = recentWeekIndices.map(idx => stats.weeks[idx])

  return (
    <div className="app">
      <header>
        <h1>TopLine Weekly Dashboard</h1>
        <p className="generated">
          Last updated: {new Date(stats.generatedAt).toLocaleString()}
        </p>
      </header>

      {/* Tab Navigation */}
      <nav className="tab-nav">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`tab-pill ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => {
              setActiveTab(tab.id)
              setSelectedMetric(null)
              setSelectedTable(null)
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main>
        {/* Table 1: Weekly Research Stats */}
        {activeTab === 'research' && (
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
        )}

        {/* Table 2: Deliverables and Total Hours */}
        {activeTab === 'deliverables' && (
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
        )}

        {/* Utilization by Analyst */}
        {activeTab === 'utilization' && stats.utilization && (
          <section className="table-section">
            <div className="section-header">
              <h2>Utilization by Analyst</h2>
              <div className="toggle-container">
                <span className={utilizationMode === 'volume' ? 'active' : ''}>Volume</span>
                <button
                  className={`toggle-switch ${utilizationMode === 'time' ? 'toggled' : ''}`}
                  onClick={() => setUtilizationMode(utilizationMode === 'volume' ? 'time' : 'volume')}
                  aria-label="Toggle utilization mode"
                >
                  <span className="toggle-slider" />
                </button>
                <span className={utilizationMode === 'time' ? 'active' : ''}>Time</span>
              </div>
            </div>

            {/* Radio Sub-table */}
            <h3 className="sub-table-title">
              Radio {utilizationMode === 'volume'
                ? `(Baseline: ${RADIO_BASELINE.requests} req/wk, ${RADIO_BASELINE.reports} reports/wk)`
                : '(2400 min/wk = 100%)'}
            </h3>
            <div className="table-container">
              <table className="utilization-table">
                <thead>
                  <tr>
                    <th className="category-col analyst-col">Analyst</th>
                    {utilizationWeeks.map((week, idx) => (
                      <th key={idx} className="data-col">{week.split(' - ')[0]}</th>
                    ))}
                    <th className="data-col avg-col">2-Wk Avg</th>
                    <th className="data-col wow-col">WoW</th>
                  </tr>
                </thead>
                <tbody>
                  {radioAnalysts.map(name => {
                    const data = getUtilizationData(name, 'radio')
                    if (!data) return null
                    const displayName = name === 'Marina' ? 'Marina' : name
                    return (
                      <tr key={name}>
                        <td className="category-col analyst-col">{displayName}</td>
                        {data.weeklyData.map((week, idx) => {
                          const util = utilizationMode === 'volume' ? week.volumeUtil : week.timeUtil
                          return (
                            <td key={idx} className={`data-col ${util >= 100 ? 'positive' : util < 50 ? 'negative' : ''}`}>
                              {util.toFixed(0)}%
                            </td>
                          )
                        })}
                        <td className={`data-col avg-col ${(utilizationMode === 'volume' ? data.avgVolumeUtil : data.avgTimeUtil) >= 100 ? 'positive' : (utilizationMode === 'volume' ? data.avgVolumeUtil : data.avgTimeUtil) < 50 ? 'negative' : ''}`}>
                          {(utilizationMode === 'volume' ? data.avgVolumeUtil : data.avgTimeUtil).toFixed(0)}%
                        </td>
                        <td className={`data-col wow-col ${getWoWClass(data.wow)}`}>
                          {formatWoW(data.wow)}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="total-row">
                    <td className="category-col analyst-col">Team Average</td>
                    {(() => {
                      const avg = getTeamUtilizationAverage(radioAnalysts, 'radio')
                      if (!avg) return null
                      return (
                        <>
                          {avg.weeklyData.map((week, idx) => {
                            const util = utilizationMode === 'volume' ? week.volumeUtil : week.timeUtil
                            return (
                              <td key={idx} className="data-col">{util.toFixed(0)}%</td>
                            )
                          })}
                          <td className="data-col avg-col">
                            {(utilizationMode === 'volume' ? avg.avgVolumeUtil : avg.avgTimeUtil).toFixed(0)}%
                          </td>
                          <td className="data-col wow-col">—</td>
                        </>
                      )
                    })()}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* TV Sub-table */}
            <h3 className="sub-table-title">
              TV {utilizationMode === 'volume'
                ? `(Baseline: ${TV_BASELINE.requests} req/wk, ${TV_BASELINE.reports} reports/wk)`
                : '(2400 min/wk = 100%)'}
            </h3>
            <div className="table-container">
              <table className="utilization-table">
                <thead>
                  <tr>
                    <th className="category-col analyst-col">Analyst</th>
                    {utilizationWeeks.map((week, idx) => (
                      <th key={idx} className="data-col">{week.split(' - ')[0]}</th>
                    ))}
                    <th className="data-col avg-col">2-Wk Avg</th>
                    <th className="data-col wow-col">WoW</th>
                  </tr>
                </thead>
                <tbody>
                  {tvAnalysts.map(name => {
                    const data = getUtilizationData(name, 'tv')
                    if (!data) return null
                    return (
                      <tr key={name}>
                        <td className="category-col analyst-col">{name}</td>
                        {data.weeklyData.map((week, idx) => {
                          const util = utilizationMode === 'volume' ? week.volumeUtil : week.timeUtil
                          return (
                            <td key={idx} className={`data-col ${util >= 100 ? 'positive' : util < 50 ? 'negative' : ''}`}>
                              {util.toFixed(0)}%
                            </td>
                          )
                        })}
                        <td className={`data-col avg-col ${(utilizationMode === 'volume' ? data.avgVolumeUtil : data.avgTimeUtil) >= 100 ? 'positive' : (utilizationMode === 'volume' ? data.avgVolumeUtil : data.avgTimeUtil) < 50 ? 'negative' : ''}`}>
                          {(utilizationMode === 'volume' ? data.avgVolumeUtil : data.avgTimeUtil).toFixed(0)}%
                        </td>
                        <td className={`data-col wow-col ${getWoWClass(data.wow)}`}>
                          {formatWoW(data.wow)}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="total-row">
                    <td className="category-col analyst-col">Team Average</td>
                    {(() => {
                      const avg = getTeamUtilizationAverage(tvAnalysts, 'tv')
                      if (!avg) return null
                      return (
                        <>
                          {avg.weeklyData.map((week, idx) => {
                            const util = utilizationMode === 'volume' ? week.volumeUtil : week.timeUtil
                            return (
                              <td key={idx} className="data-col">{util.toFixed(0)}%</td>
                            )
                          })}
                          <td className="data-col avg-col">
                            {(utilizationMode === 'volume' ? avg.avgVolumeUtil : avg.avgTimeUtil).toFixed(0)}%
                          </td>
                          <td className="data-col wow-col">—</td>
                        </>
                      )
                    })()}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Table 4: Research Team Output */}
        {activeTab === 'team' && (
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
                    // Display Marina Nasonti instead of Marina
                    const displayName = name === 'Marina' ? 'Marina' : name

                    return (
                      <tr
                        key={name}
                        className={isSelected ? 'selected' : ''}
                        onClick={() => handleRowClick(name, 'analyst')}
                      >
                        <td className="category-col analyst-col">{displayName}</td>
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
                  {/* Total rows */}
                  <tr className="total-row">
                    <td className="category-col analyst-col"># of Reports</td>
                    {teamTotals.reportsCompleted.map((val, idx) => (
                      [
                        <td key={`${idx}-reports`} className="data-col">{val.toLocaleString()}</td>,
                        <td key={`${idx}-pct`} className="data-col pct-col">100%</td>
                      ]
                    )).flat()}
                    <td className="data-col avg-col">{teamTotals.fourWeekAvgReports.toLocaleString()}</td>
                    <td className={`data-col wow-col ${getWoWClass(teamTotals.wowReports)}`}>
                      {formatWoW(teamTotals.wowReports)}
                    </td>
                  </tr>
                  <tr className="total-row">
                    <td className="category-col analyst-col">Avg Time per Report (mins)</td>
                    {teamTotals.avgMinutes.map((val, idx) => (
                      [
                        <td key={`${idx}-reports`} className="data-col">{val}</td>,
                        <td key={`${idx}-pct`} className="data-col pct-col">—</td>
                      ]
                    )).flat()}
                    <td className="data-col avg-col">{teamTotals.fourWeekAvgMinutes}</td>
                    <td className={`data-col wow-col ${getWoWClass(teamTotals.wowMinutes)}`}>
                      {formatWoW(teamTotals.wowMinutes)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}

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
