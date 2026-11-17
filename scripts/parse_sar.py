import sys, json
from html.parser import HTMLParser
class P(HTMLParser):
    def __init__(s):
        super().__init__(); s.h1=s.h2=None; s.cur=None; s.tables=[]; s.intag=None; s.buf=''; s.row=None; s.cell=None
    def handle_starttag(s,t,a):
        if t in('h1','h2'): s.intag=t; s.buf=''
        elif t=='table': s.cur={'h1':s.h1,'h2':s.h2,'rows':[]}; s.tables.append(s.cur)
        elif t=='tr' and s.cur is not None: s.row=[]
        elif t in('td','th') and s.row is not None: s.cell=''
    def handle_endtag(s,t):
        if t==s.intag:
            v=s.buf.strip()
            if t=='h1': s.h1=v; s.h2=None
            else: s.h2=v
            s.intag=None
        elif t in('td','th') and s.cell is not None: s.row.append(s.cell.strip()); s.cell=None
        elif t=='tr' and s.row is not None: s.cur['rows'].append(s.row); s.row=None
        elif t=='table': s.cur=None
    def handle_data(s,d):
        if s.intag: s.buf+=d
        if s.cell is not None: s.cell+=d
p=P(); p.feed(open(sys.argv[1],encoding='utf-8').read())
json.dump(p.tables, open(sys.argv[2],'w'), indent=1)
for i,t in enumerate(p.tables):
    r=t['rows']; print(f"\n=== [{i}] {t['h1']} / {t['h2']}  rows={len(r)}")
    for row in r[:4]: print('   ', row)
