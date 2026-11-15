import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SECTIONS, type ClassSection } from "./class-section";

export function SectionTabs({ section, onSelect }: { section: ClassSection; onSelect: (section: ClassSection) => void }) {
  return (
    <Tabs value={section} onValueChange={(value) => onSelect(value as ClassSection)}>
      <TabsList variant="line" data-testid="section-tabs" className="h-auto justify-start">
        {SECTIONS.map((item) => (
          <TabsTrigger key={item.value} value={item.value} data-testid="section-tab" data-section={item.value} className="flex-none px-3">
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
