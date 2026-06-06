import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
} from "sequelize-typescript";

@Table({ tableName: "genre_overrides", timestamps: true })
export class GenreOverride extends Model {
  @PrimaryKey
  @Column(DataType.STRING)
  genre_key!: string; // "{type}_{genre_id}" e.g. "movie_42"

  @Column({ type: DataType.STRING, allowNull: true })
  display_name!: string | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  hidden!: boolean;

  @Column({ type: DataType.INTEGER, allowNull: true })
  sort_order!: number | null;

  @Default(false)
  @Column(DataType.BOOLEAN)
  virtual!: boolean;

  @Column({ type: DataType.STRING, allowNull: true })
  virtual_title!: string | null;
}
