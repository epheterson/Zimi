# How the Z was identified: renders candidate settings of the system font the way generate_icons.py did and scores each
# against zimi/assets/icon.png (macOS only, needs pyobjc and Pillow). The winner is SF Compact at its default instance.
"""Find the font setting icon.png was rendered with, by rendering candidates the way generate_icons.py does."""
import os, CoreText, Quartz
from PIL import Image
icon=Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'zimi', 'assets', 'icon.png')).convert('RGB')
W=lambda t: int.from_bytes(t.encode(),'big')
def font(wght=None, opsz=None, trait=True, size=1000):
    f=CoreText.CTFontCreateWithName(".AppleSystemUIFont", size, None)
    if trait: f=CoreText.CTFontCreateCopyWithSymbolicTraits(f,size,None,CoreText.kCTFontBoldTrait,CoreText.kCTFontBoldTrait) or f
    v={}
    if wght: v[W('wght')]=wght
    if opsz: v[W('opsz')]=opsz
    if v:
        d=CoreText.CTFontDescriptorCreateWithAttributes({CoreText.kCTFontVariationAttribute:v})
        f=CoreText.CTFontCreateCopyWithAttributes(f,size,None,d)
    return f
def render(f, size=1024):
    """generate_icons.create_icon: box 0.8*size, font 0.72*box, glyph bounds centred."""
    cs=Quartz.CGColorSpaceCreateDeviceRGB()
    ctx=Quartz.CGBitmapContextCreate(None,size,size,8,size*4,cs,Quartz.kCGImageAlphaPremultipliedLast)
    Quartz.CGContextSetRGBFillColor(ctx,0,0,0,1); Quartz.CGContextFillRect(ctx,Quartz.CGRectMake(0,0,size,size))
    astr=CoreText.CFAttributedStringCreate(None,"Z",{CoreText.kCTFontAttributeName:f,CoreText.kCTForegroundColorFromContextAttributeName:True})
    line=CoreText.CTLineCreateWithAttributedString(astr)
    b=CoreText.CTLineGetImageBounds(line,ctx)
    Quartz.CGContextSetRGBFillColor(ctx,1,1,1,1)
    Quartz.CGContextSetTextPosition(ctx,(size-b.size.width)/2-b.origin.x,(size-b.size.height)/2-b.origin.y)
    CoreText.CTLineDraw(line,ctx)
    img=Quartz.CGBitmapContextCreateImage(ctx); data=Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(img))
    return Image.frombytes("RGBA",(size,size),bytes(data)).convert('L').resize((256,256),Image.LANCZOS)
def err(m):
    e=0;n=0
    for y in range(70,186):
        for x in range(80,176):
            a=max(0,min(1,(icon.getpixel((x,y))[0]-10)/226)); e+=abs(a-m.getpixel((x,y))/255); n+=1
    return e/n
box=int(1024*.8); fs=int(box*.72)
for args in [dict(),dict(wght=700),dict(wght=800),dict(wght=900),dict(wght=1000),dict(wght=700,opsz=17),dict(wght=800,opsz=17),dict(wght=900,opsz=17),dict(wght=700,opsz=28),dict(wght=800,opsz=28),dict(wght=900,opsz=28)]:
    f=font(size=fs,**args); print(args, CoreText.CTFontCopyFullName(f), '%.4f'%err(render(f)))
