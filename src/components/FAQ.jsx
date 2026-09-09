import { useState } from 'react';
import { ChevronDown, Mail, MessageCircle } from 'lucide-react';

const faqData = [
  {
    question: 'What is FRC?',
    answer: "FRC (FIRST Robotics Competition) is an international high school robotics competition. Each year, teams build and program industrial-size robots to compete in a challenging field game — as close to real-world engineering as a student can get."
  },
  {
    question: 'Who can join MCHS Robotics?',
    answer: "Any MCHS student can join — no experience required. Whether you're interested in programming, mechanical design, electrical work, marketing, or just want to learn, there's a place for you."
  },
  {
    question: 'When and where does the team meet?',
    answer: "We meet regularly in the school's robotics shop. During build season (January–February), meetings increase in frequency. Check the team board or contact a team lead for the current schedule."
  },
  {
    question: 'Where are the weekly meetings held?',
    answer: "<p>We have two weekly meeting locations:</p><ul><li><strong>Wednesdays</strong> during lunch in <strong>F1</strong></li><li><strong>Thursdays</strong> from 4:00 PM to 6:00 PM in <strong>C5</strong></li></ul><p>All members are welcome at both sessions!</p>"
  },
  {
    question: 'What skills will I learn?',
    answer: 'Members learn CAD design, programming (Java/C++/Python), electrical wiring, mechanical fabrication, project management, and communication — all of which translate directly to college and STEM careers.'
  },
  {
    question: 'Does it cost anything to join?',
    answer: 'No dues to join. We fundraise throughout the year to cover competition fees, parts, and travel expenses. All members are encouraged to participate in fundraising activities.'
  },
  {
    question: 'What is the time commitment?',
    answer: 'Off-season: 2–3 meetings per week. Build season (6 weeks in January): significantly more. We work to accommodate other commitments and understand students have busy schedules.'
  },
  {
    question: 'Do I need prior experience?',
    answer: "None required. Our veteran members and mentors teach everything from the ground up. Enthusiasm and willingness to learn are all you need."
  },
  {
    question: 'What competitions do you participate in?',
    answer: 'We compete in regional FRC events and potentially the World Championship if we qualify. We also attend off-season events to give newer members competition experience.'
  },
  {
    question: 'How can parents get involved?',
    answer: 'Parents can volunteer at competitions, help with fundraising, offer mentorship in their areas of expertise, or simply support team members.'
  },
  {
    question: 'What is the team board?',
    answer: "The team board is our simple built-in messaging space — organized into channels for announcements, build, programming, and general chatter. Paste links, coordinate meetups, and stay in the loop. No extra apps or accounts needed."
  }
];

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <div className="min-h-screen py-16 px-6" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-xl mx-auto">

        {/* Header */}
        <div className="mb-12">
          <p className="text-xs font-medium uppercase tracking-widest mb-3" style={{ color: 'var(--text-subtle)' }}>
            FAQ
          </p>
          <h1 className="text-2xl font-semibold mb-2"
              style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Frequently Asked Questions
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Everything you need to know about MCHS Robotics Team 5728.
          </p>
        </div>

        {/* Items */}
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {faqData.map((faq, index) => (
            <div key={index} style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                className="w-full py-4 flex items-center justify-between text-left group"
              >
                <span className="text-sm pr-6 transition-colors duration-150"
                      style={{ color: openIndex === index ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {faq.question}
                </span>
                <ChevronDown
                  className="w-4 h-4 flex-shrink-0 transition-transform duration-200"
                  style={{
                    color: 'var(--text-subtle)',
                    transform: openIndex === index ? 'rotate(180deg)' : 'rotate(0deg)'
                  }}
                />
              </button>
              {openIndex === index && (
                <div className="pb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}
                     dangerouslySetInnerHTML={{ __html: faq.answer }} />
              )}
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="mt-12 pt-8" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>Still have questions?</p>
          <div className="flex gap-2">
            <button
              className="flex items-center gap-2 px-4 py-2 rounded text-xs transition-colors duration-150"
              style={{ border: '1px solid var(--border-light)', color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-light)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <Mail className="w-3.5 h-3.5" />
              Contact Us
            </button>
            <button
              className="flex items-center gap-2 px-4 py-2 rounded text-xs transition-colors duration-150"
              style={{ border: '1px solid var(--border-light)', color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-subtle)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-light)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <MessageCircle className="w-3.5 h-3.5" />
              Join Chat
            </button>
          </div>
        </div>

        <p className="mt-12 text-xs" style={{ color: 'var(--text-subtle)' }}>
          © {new Date().getFullYear()} MCHS Robotics · Team 5728
        </p>
      </div>
    </div>
  );
}
